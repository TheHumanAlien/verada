// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title HookMiner
/// @notice Finds CREATE2 salts whose resulting address encodes a given set of v4 hook flags.
/// @dev Uniswap v4 reads hook permissions from the low 14 bits of the hook address, so the
///      address must match the wanted flags exactly in those bits.
library HookMiner {
    /// @dev Mask over the 14 permission bits of a hook address.
    uint160 internal constant FLAG_MASK = uint160((1 << 14) - 1);
    /// @dev Default search bound; a 4-flag target needs about 16k attempts on average.
    uint256 internal constant DEFAULT_MAX_LOOP = 400_000;

    error SaltNotFound();

    /// @notice Computes the CREATE2 address for `deployer`, `salt` and `initCode`.
    function computeAddress(address deployer, bytes32 salt, bytes memory initCode)
        internal
        pure
        returns (address)
    {
        return computeAddressFromHash(deployer, salt, keccak256(initCode));
    }

    /// @notice Computes the CREATE2 address given the init code hash.
    function computeAddressFromHash(address deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))
            )
        );
    }

    /// @notice Whether the low 14 bits of `addr` equal `flags`.
    function hasExactFlags(address addr, uint160 flags) internal pure returns (bool) {
        return uint160(addr) & FLAG_MASK == flags;
    }

    /// @notice Mines a salt for `creationCode ++ constructorArgs` deployed by `deployer`.
    /// @param deployer The CREATE2 deployer (the contract calling `new`, or a factory).
    /// @param flags The exact permission bits the address must carry.
    /// @param creationCode `type(Hook).creationCode`.
    /// @param constructorArgs `abi.encode(...)` of the constructor arguments.
    function find(
        address deployer,
        uint160 flags,
        bytes memory creationCode,
        bytes memory constructorArgs
    ) internal view returns (address hookAddress, bytes32 salt) {
        return find(deployer, flags, creationCode, constructorArgs, 0, DEFAULT_MAX_LOOP);
    }

    /// @notice As `find`, scanning salts from `startSalt` for at most `maxLoop` attempts.
    function find(
        address deployer,
        uint160 flags,
        bytes memory creationCode,
        bytes memory constructorArgs,
        uint256 startSalt,
        uint256 maxLoop
    ) internal view returns (address hookAddress, bytes32 salt) {
        flags = flags & FLAG_MASK;
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i = 0; i < maxLoop; ++i) {
            salt = bytes32(startSalt + i);
            hookAddress = computeAddressFromHash(deployer, salt, initCodeHash);
            if (hasExactFlags(hookAddress, flags) && hookAddress.code.length == 0) {
                return (hookAddress, salt);
            }
        }
        revert SaltNotFound();
    }
}
