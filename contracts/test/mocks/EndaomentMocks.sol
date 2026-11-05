// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IEndaomentOrg} from "../../src/interfaces/external/IEndaomentOrg.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {IEndaomentRegistry} from "../../src/interfaces/external/IEndaomentRegistry.sol";

/// @dev 6-decimal USDC stand-in.
contract MockUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract MockEndaomentRegistry is IEndaomentRegistry {
    address public baseToken;
    address public treasury;
    mapping(address => bool) public isActiveEntity;
    uint32 public fee = 150;

    constructor(address base, address treasury_) {
        baseToken = base;
        treasury = treasury_;
    }

    function setActive(address e, bool v) external {
        isActiveEntity[e] = v;
    }

    function setFee(uint32 f) external {
        fee = f;
    }

    function getDonationFee(address) external view returns (uint32) {
        return fee;
    }
}

contract MockOrg is IEndaomentOrg {
    MockEndaomentRegistry public registry;
    bytes32 public orgId;
    address public baseToken;
    uint256 public balance;

    constructor(MockEndaomentRegistry registry_, bytes32 orgId_) {
        registry = registry_;
        orgId = orgId_;
        baseToken = registry_.baseToken();
    }

    /// @dev Mirrors the real entity: fee to treasury, net to the org, both pulled from the caller.
    function donate(uint256 amount) external {
        uint256 f = amount * registry.getDonationFee(address(this)) / 10_000;
        IERC20(baseToken).transferFrom(msg.sender, registry.treasury(), f);
        IERC20(baseToken).transferFrom(msg.sender, address(this), amount - f);
        balance += amount - f;
    }
}

/// @dev Deploys MockOrgs with CREATE2 salted by orgId, like the real factory.
contract MockOrgFactory is IEndaomentOrgFundFactory {
    MockEndaomentRegistry public immutable registryContract;
    address public immutable baseToken;
    /// @dev When set, `deployOrgAndDonate` returns this instead of the real org (negative test).
    address public lie;

    constructor(MockEndaomentRegistry r) {
        registryContract = r;
        baseToken = r.baseToken();
    }

    function registry() external view returns (address) {
        return address(registryContract);
    }

    function setLie(address a) external {
        lie = a;
    }

    function computeOrgAddress(bytes32 orgId) public view returns (address) {
        bytes memory init =
            abi.encodePacked(type(MockOrg).creationCode, abi.encode(registryContract, orgId));
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), orgId, keccak256(init)))
                )
            )
        );
    }

    function deployOrg(bytes32 orgId) public returns (address org) {
        org = address(new MockOrg{salt: orgId}(registryContract, orgId));
        registryContract.setActive(org, true);
    }

    function deployOrgAndDonate(bytes32 orgId, uint256 amount) external returns (address org) {
        org = deployOrg(orgId);
        uint256 f = amount * registryContract.getDonationFee(org) / 10_000;
        IERC20(baseToken).transferFrom(msg.sender, registryContract.treasury(), f);
        IERC20(baseToken).transferFrom(msg.sender, org, amount - f);
        if (lie != address(0)) return lie;
    }
}
