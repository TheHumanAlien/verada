// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";

/// @dev The governor keeps only a commitment to each ballot; its options live in `BallotPrepared`.
///      Tests read them back the way off-chain consumers do: from the logs. Call `_recordBallots`
///      in `setUp` before any ballot is prepared; the helpers then scan the logs recorded since the
///      last call and remember every ballot per (governor, token, epoch).
abstract contract BallotLog is Test {
    mapping(address governor => mapping(address token => mapping(uint256 epoch => bytes32[])))
        private _ballots;

    function _recordBallots() internal {
        vm.recordLogs();
    }

    function _syncBallots() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length != 3 || l.topics[0] != IEpochGovernor.BallotPrepared.selector) {
                continue;
            }
            (,,, bytes32[] memory ids) = abi.decode(l.data, (uint32, uint256, uint8, bytes32[]));
            address token = address(uint160(uint256(l.topics[1])));
            _ballots[l.emitter][token][uint256(l.topics[2])] = ids;
        }
    }

    /// @dev Org ids of the ballot `governor` prepared for `(token, epoch)` (empty if none).
    function _orgIds(address governor, address token, uint256 epoch)
        internal
        returns (bytes32[] memory)
    {
        _syncBallots();
        return _ballots[governor][token][epoch];
    }

    /// @dev Cause ids (`keccak256(orgId)`) of that ballot's options, in ballot order.
    function _options(address governor, address token, uint256 epoch)
        internal
        returns (bytes32[] memory causes)
    {
        bytes32[] memory orgs = _orgIds(governor, token, epoch);
        causes = new bytes32[](orgs.length);
        for (uint256 i; i < orgs.length; ++i) {
            causes[i] = keccak256(abi.encode(orgs[i]));
        }
    }
}
