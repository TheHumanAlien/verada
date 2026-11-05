// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC5805} from "@openzeppelin/contracts/interfaces/IERC5805.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ERC20TimestampVotes
/// @notice ERC-5805 vote checkpoints for an ERC-20, keyed by `block.timestamp` (ERC-6372
///         `mode=timestamp`). Exposes the same surface as OpenZeppelin's `ERC20Votes` so governors
///         can read `getPastVotes` at a past timestamp.
/// @dev Written for solc 0.8.26, which the current OpenZeppelin `Votes`/`Checkpoints` sources no
///      longer target. A checkpoint packs `(uint48 timestamp, uint208 votes)` into one slot; the
///      total supply is capped at `type(uint208).max` so packed arithmetic cannot overflow.
///      `delegateBySig` is left to the concrete token, which owns the EIP-712 domain and nonces.
abstract contract ERC20TimestampVotes is ERC20, IERC5805 {
    struct Checkpoint {
        uint48 key;
        uint208 value;
    }

    /// @dev Lookups are only available for timepoints strictly in the past.
    error ERC5805FutureLookup(uint256 timepoint, uint48 clock);
    /// @dev Minting past the checkpoint-safe supply cap.
    error ERC20ExceededSafeSupply(uint256 increasedSupply, uint256 cap);

    mapping(address account => address) private _delegatee;
    mapping(address delegatee => Checkpoint[]) private _delegateCheckpoints;
    Checkpoint[] private _totalCheckpoints;

    // ------------------------------------------------------------------ ERC-6372

    /// @inheritdoc IERC6372
    function clock() public view virtual returns (uint48) {
        // Timestamps fit in 48 bits for the next few million years.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint48(block.timestamp);
    }

    /// @inheritdoc IERC6372
    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public view virtual returns (string memory) {
        return "mode=timestamp";
    }

    // ------------------------------------------------------------------ IVotes views

    /// @inheritdoc IVotes
    function getVotes(address account) public view virtual returns (uint256) {
        return _latest(_delegateCheckpoints[account]);
    }

    /// @inheritdoc IVotes
    function getPastVotes(address account, uint256 timepoint)
        public
        view
        virtual
        returns (uint256)
    {
        return _upperLookup(_delegateCheckpoints[account], _validateTimepoint(timepoint));
    }

    /// @inheritdoc IVotes
    function getPastTotalSupply(uint256 timepoint) public view virtual returns (uint256) {
        return _upperLookup(_totalCheckpoints, _validateTimepoint(timepoint));
    }

    /// @inheritdoc IVotes
    function delegates(address account) public view virtual returns (address) {
        return _delegatee[account];
    }

    /// @notice Number of vote checkpoints recorded for `account`.
    function numCheckpoints(address account) public view virtual returns (uint32) {
        // Bounded by the number of distinct timestamps with activity; far below 2^32.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(_delegateCheckpoints[account].length);
    }

    /// @notice The `pos`-th checkpoint of `account`.
    function checkpoints(address account, uint32 pos)
        public
        view
        virtual
        returns (Checkpoint memory)
    {
        return _delegateCheckpoints[account][pos];
    }

    // ------------------------------------------------------------------ delegation

    /// @inheritdoc IVotes
    function delegate(address delegatee) public virtual {
        _delegate(_msgSender(), delegatee);
    }

    /// @dev Largest total supply the checkpoints can represent.
    function _maxSupply() internal view virtual returns (uint256) {
        return type(uint208).max;
    }

    /// @dev Points all of `account`'s voting units at `delegatee` and moves them there.
    function _delegate(address account, address delegatee) internal virtual {
        address previous = _delegatee[account];
        _delegatee[account] = delegatee;
        emit DelegateChanged(account, previous, delegatee);
        _moveDelegateVotes(previous, delegatee, balanceOf(account));
    }

    /// @dev Moves voting units together with the tokens. Mints and burns also update the supply
    ///      checkpoints.
    function _update(address from, address to, uint256 value) internal virtual override {
        super._update(from, to, value);
        if (from == address(0)) {
            uint256 supply = totalSupply();
            uint256 cap = _maxSupply();
            if (supply > cap) revert ERC20ExceededSafeSupply(supply, cap);
            _push(_totalCheckpoints, true, value);
        }
        if (to == address(0)) _push(_totalCheckpoints, false, value);
        _moveDelegateVotes(_delegatee[from], _delegatee[to], value);
    }

    function _moveDelegateVotes(address from, address to, uint256 amount) internal virtual {
        if (from == to || amount == 0) return;
        if (from != address(0)) {
            (uint256 previous, uint256 current) = _push(_delegateCheckpoints[from], false, amount);
            emit DelegateVotesChanged(from, previous, current);
        }
        if (to != address(0)) {
            (uint256 previous, uint256 current) = _push(_delegateCheckpoints[to], true, amount);
            emit DelegateVotesChanged(to, previous, current);
        }
    }

    // ------------------------------------------------------------------ checkpoints

    /// @dev Applies `delta` to the latest value of `trace` at the current clock, overwriting the
    ///      last checkpoint when it was written in this same second.
    function _push(Checkpoint[] storage trace, bool add, uint256 delta)
        private
        returns (uint208 previous, uint208 current)
    {
        uint256 length = trace.length;
        uint48 key = clock();
        previous = length == 0 ? 0 : trace[length - 1].value;
        // `delta` never exceeds the total supply, which `_update` keeps within `_maxSupply()`.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint208 step = uint208(delta);
        current = add ? previous + step : previous - step;
        if (length != 0 && trace[length - 1].key == key) {
            trace[length - 1].value = current;
        } else {
            trace.push(Checkpoint({key: key, value: current}));
        }
    }

    function _latest(Checkpoint[] storage trace) private view returns (uint256) {
        uint256 length = trace.length;
        return length == 0 ? 0 : trace[length - 1].value;
    }

    /// @dev Value of the last checkpoint with `key <= timepoint`, or zero when there is none.
    function _upperLookup(Checkpoint[] storage trace, uint48 timepoint)
        private
        view
        returns (uint256)
    {
        uint256 low;
        uint256 high = trace.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (trace[mid].key > timepoint) high = mid;
            else low = mid + 1;
        }
        return low == 0 ? 0 : trace[low - 1].value;
    }

    function _validateTimepoint(uint256 timepoint) private view returns (uint48) {
        uint48 current = clock();
        if (timepoint >= current) revert ERC5805FutureLookup(timepoint, current);
        // Strictly below a uint48 clock value, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint48(timepoint);
    }
}
