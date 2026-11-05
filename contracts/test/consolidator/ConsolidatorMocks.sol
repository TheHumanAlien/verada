// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain mintable token with configurable decimals.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, uint8 dec) ERC20(n, n) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Ondo-like token: transfers revert while paused and for non-compliant (blocked) parties,
///      mirroring the pause manager plus compliance checks of the real tokens.
contract MockOndoToken is ERC20 {
    bool public paused;
    mapping(address account => bool) public blocked;

    error TokenPaused();
    error NotCompliant(address account);

    constructor(string memory n) ERC20(n, n) {}

    /// @dev Test helper: minting bypasses the pause and compliance checks.
    function mint(address to, uint256 amount) external {
        super._update(address(0), to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address account, bool b) external {
        blocked[account] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused) revert TokenPaused();
        if (from != address(0) && blocked[from]) revert NotCompliant(from);
        if (to != address(0) && blocked[to]) revert NotCompliant(to);
        super._update(from, to, value);
    }
}

/// @dev WETH9-style wrapper.
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    receive() external payable {
        _mint(msg.sender, msg.value);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "eth");
    }
}

contract MockGovernor {
    uint256 public constant EPOCH_LENGTH = 7 days;

    mapping(address => mapping(uint256 => bool)) public isFinalized;
    uint256 private _manualEpoch;
    /// @dev When set, epochs follow the clock like the real governor.
    bool public timeBased;
    uint256 public epochZeroStart;

    function setCurrentEpoch(uint256 e) external {
        _manualEpoch = e;
        timeBased = false;
    }

    function useClock(uint256 zeroStart) external {
        epochZeroStart = zeroStart;
        timeBased = true;
    }

    function currentEpoch() public view returns (uint256) {
        return timeBased ? (block.timestamp - epochZeroStart) / EPOCH_LENGTH : _manualEpoch;
    }

    function epochStart(uint256 epoch) external view returns (uint256) {
        return epochZeroStart + epoch * EPOCH_LENGTH;
    }

    function setFinalized(address token, uint256 epoch, bool v) external {
        isFinalized[token][epoch] = v;
    }
}

contract MockDistributor {
    mapping(address token => mapping(uint256 epoch => uint256)) public received;

    function receiveFunds(address token, uint256 epoch, uint256 amount) external {
        received[token][epoch] += amount;
    }
}

/// @dev A one element array, for `FeeVault.depositFees` parts.
function single(uint256 v) pure returns (uint256[] memory a) {
    a = new uint256[](1);
    a[0] = v;
}

/// @dev Stands in for the consolidator in vault tests: deposits are pranked from its address,
///      `flushThrough` reports a configurable outcome.
contract MockFlushConsolidator {
    bool public pending;
    uint256 public flushes;

    function setPending(bool v) external {
        pending = v;
    }

    bool public reverting;

    function setReverting(bool v) external {
        reverting = v;
    }

    function flushThrough(address, uint256) external returns (bool) {
        require(!reverting, "flush failed");
        ++flushes;
        return !pending;
    }
}
