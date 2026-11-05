// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {ILpLocker} from "../../src/interfaces/ILpLocker.sol";
import {
    MockDistributor,
    MockERC20,
    MockFlushConsolidator,
    MockGovernor,
    single
} from "../consolidator/ConsolidatorMocks.sol";

/// @dev The vault credits the accrual epoch given by the consolidator, not the deposit epoch.
contract FeeVaultAttributionTest is Test {
    FeeVault vault;
    MockERC20 usdc;
    MockGovernor governor;
    MockDistributor distributor;

    address consolidator = address(new MockFlushConsolidator());
    address token = makeAddr("token");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        governor = new MockGovernor();
        distributor = new MockDistributor();
        vault = new FeeVault(
            address(this),
            address(this),
            makeAddr("treasury"),
            IEpochGovernor(address(governor)),
            address(distributor),
            address(usdc)
        );
        vault.setConsolidator(consolidator);
        vault.registerToken(token);
    }

    function _deposit(uint256 amount, uint256 accrualEpoch) internal {
        usdc.mint(address(vault), amount);
        vm.prank(consolidator);
        vault.depositFees(token, single(accrualEpoch), single(amount));
    }

    function _depositExpecting(uint256 amount, uint256 accrualEpoch, uint256 credited) internal {
        usdc.mint(address(vault), amount);
        (, uint256 cause) = vault.split(amount);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IFeeVault.FeesAttributed(token, credited, accrualEpoch, cause);
        vm.prank(consolidator);
        vault.depositFees(token, single(accrualEpoch), single(amount));
    }

    function test_exposesGovernor() public view {
        assertEq(address(vault.governor()), address(governor));
    }

    function test_depositCreditsAccrualEpoch() public {
        governor.setCurrentEpoch(5);
        _depositExpecting(1000, 2, 2);
        assertEq(vault.causePoolOf(token, 2), 900);
        assertEq(vault.causePoolOf(token, 5), 0);
        assertEq(vault.causePool(token), 900);
    }

    function test_depositForFutureEpochReverts() public {
        governor.setCurrentEpoch(5);
        usdc.mint(address(vault), 1000);
        vm.prank(consolidator);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.FutureEpoch.selector, 6, 5));
        vault.depositFees(token, single(6), single(1000));
    }

    function test_lateDepositSkipsSettledEpochs() public {
        governor.setCurrentEpoch(6);
        _deposit(1000, 2);
        _deposit(1000, 3);
        governor.setFinalized(token, 2, true);
        governor.setFinalized(token, 3, true);
        vault.settle(token, 2);
        vault.settle(token, 3);

        _depositExpecting(500, 2, 4);
        assertEq(vault.causePoolOf(token, 4), 450);
        assertEq(vault.causePoolOf(token, 6), 0);

        // Epoch 4 can now be settled for its winner; nothing is stranded.
        governor.setFinalized(token, 4, true);
        vault.settle(token, 4);
        assertEq(distributor.received(token, 4), 450);
    }

    /// The current epoch is the last stop even if a governor reported it as settled.
    function test_lateDepositStopsAtCurrentEpoch() public {
        governor.setCurrentEpoch(1);
        _deposit(1000, 0);
        governor.setFinalized(token, 0, true);
        vault.settle(token, 0);
        _deposit(1000, 0);
        assertEq(vault.causePoolOf(token, 1), 900);
    }

    /// One deposit of several epoch parts emits one `FeesCollected` with the totals (so an
    /// indexer counts one collection) and one `FeesAttributed` per part.
    function test_multiPartDepositEmitsTotalsOnce() public {
        governor.setCurrentEpoch(4);
        uint256[] memory epochs = new uint256[](3);
        uint256[] memory amounts = new uint256[](3);
        (epochs[0], epochs[1], epochs[2]) = (1, 2, 4);
        (amounts[0], amounts[1], amounts[2]) = (1000, 0, 2000);
        usdc.mint(address(vault), 3000);

        vm.recordLogs();
        vm.prank(consolidator);
        vault.depositFees(token, epochs, amounts);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 collected = IFeeVault.FeesCollected.selector;
        bytes32 attributed = IFeeVault.FeesAttributed.selector;
        uint256 nCollected;
        uint256 nAttributed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == collected) {
                ++nCollected;
                (uint256 platform, uint256 cause,) =
                    abi.decode(logs[i].data, (uint256, uint256, address));
                assertEq(platform, 300);
                assertEq(cause, 2700);
            } else if (logs[i].topics[0] == attributed) {
                ++nAttributed;
            }
        }
        assertEq(nCollected, 1, "one collection");
        assertEq(nAttributed, 2, "one attribution per non-zero part");
        assertEq(vault.causePoolOf(token, 1), 900);
        assertEq(vault.causePoolOf(token, 4), 1800);
        assertEq(vault.totalTracked(), 3000);
    }

    function test_depositPartsLengthMismatchReverts() public {
        vm.prank(consolidator);
        vm.expectRevert(FeeVault.LengthMismatch.selector);
        vault.depositFees(token, new uint256[](2), single(1));
    }

    /// While the consolidator still holds fees of the epoch, settling waits until the grace
    /// period after the epoch's end; then it proceeds.
    function test_settleWaitsWhileConsolidatorHoldsFees() public {
        governor.setCurrentEpoch(3);
        _deposit(1000, 2);
        governor.setFinalized(token, 2, true);
        MockFlushConsolidator(consolidator).setPending(true);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.FeesPending.selector, token, 2));
        vault.settle(token, 2);

        vm.warp(governor.epochStart(3) + vault.SETTLE_GRACE());
        vault.settle(token, 2);
        assertEq(distributor.received(token, 2), 900);
    }

    /// A consolidator that reverts only delays settling to the grace period; nothing strands.
    function test_revertingConsolidatorOnlyDelaysSettle() public {
        governor.setCurrentEpoch(3);
        _deposit(1000, 2);
        governor.setFinalized(token, 2, true);
        MockFlushConsolidator(consolidator).setReverting(true);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.FeesPending.selector, token, 2));
        vault.settle(token, 2);
        vm.warp(governor.epochStart(3) + vault.SETTLE_GRACE());
        vault.settle(token, 2);
        assertEq(distributor.received(token, 2), 900);
    }

    /// Settling collects LP fees first when the last collection predates the epoch's end; a
    /// collection that cannot happen blocks settling until the grace period.
    function test_settleCollectsLpFeesFirst() public {
        MockSettleLocker lpLocker = new MockSettleLocker();
        vault.setLpLocker(ILpLocker(address(lpLocker)));
        governor.setCurrentEpoch(3);
        _deposit(1000, 2);
        governor.setFinalized(token, 2, true);
        uint256 end = governor.epochStart(3);
        vm.warp(end + 1 hours);

        lpLocker.setLast(token, end - 1 hours);
        lpLocker.setFailing(true);
        vm.expectRevert(abi.encodeWithSelector(IFeeVault.FeesPending.selector, token, 2));
        vault.settle(token, 2);

        lpLocker.setFailing(false);
        vault.settle(token, 2);
        assertEq(lpLocker.collects(), 1);
        assertEq(lpLocker.lastCollectedAt(token), end + 1 hours);
        assertEq(distributor.received(token, 2), 900);
    }

    /// A token without a locked position (no collection time) does not wait for the locker.
    function test_settleSkipsTokenWithoutPosition() public {
        MockSettleLocker lpLocker = new MockSettleLocker();
        vault.setLpLocker(ILpLocker(address(lpLocker)));
        governor.setCurrentEpoch(3);
        _deposit(1000, 2);
        governor.setFinalized(token, 2, true);
        vault.settle(token, 2);
        assertEq(lpLocker.collects(), 0);
    }

    function test_lpLockerSetOnceByOwner() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        vault.setLpLocker(ILpLocker(address(1)));
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.setLpLocker(ILpLocker(address(0)));
        vault.setLpLocker(ILpLocker(address(1)));
        vm.expectRevert(FeeVault.LpLockerAlreadySet.selector);
        vault.setLpLocker(ILpLocker(address(2)));
    }
}

/// @dev Locker stand-in for settlement: a settable collection time and a collect that can fail.
contract MockSettleLocker {
    mapping(address => uint256) public lastCollectedAt;
    bool public failing;
    uint256 public collects;

    function setLast(address token, uint256 t) external {
        lastCollectedAt[token] = t;
    }

    function setFailing(bool v) external {
        failing = v;
    }

    function collectFees(address token) external returns (uint256, uint256) {
        require(!failing, "collect failed");
        ++collects;
        lastCollectedAt[token] = block.timestamp;
        return (0, 0);
    }
}
