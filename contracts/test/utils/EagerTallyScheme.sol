// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FHE, euint128} from "@fhevm/solidity/lib/FHE.sol";

import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";

/// @dev `ZamaVotingScheme` that can replay the eager tally setup it used to do in `open`, so gas
///      tests can measure the old behaviour next to the lazy one on the same deployment. Calling
///      `preallocate` right after `open` leaves the poll exactly as the eager `open` did: one
///      encrypted zero per tally word, allowed to the scheme. Ballots then take the add path.
contract EagerTallyScheme is ZamaVotingScheme {
    constructor(address initialOwner) ZamaVotingScheme(initialOwner) {}

    function preallocate(address governor, address token, uint256 scope) public {
        Poll storage poll = _pollOf(governor, token, scope);
        require(poll.opened && poll.tallies.length == 0, "not a fresh poll");
        uint256 words = wordCount(poll.optionCount);
        for (uint256 i = 0; i < words; ++i) {
            euint128 zero = FHE.asEuint128(0);
            FHE.allowThis(zero);
            poll.tallies.push(zero);
        }
    }
}
