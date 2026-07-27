import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: true,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => native.isTauri,
}));

import {
  completePairing,
  createPairingOffer,
  createPairingRequest,
  generateAuthenticationChallenge,
  getDeviceIdentity,
  listTrustedPeers,
  renameTrustedPeer,
  revokeTrustedPeer,
  signAuthenticationChallenge,
  trustPairingOffer,
  verifyTrustedPeerSignature,
  type PairingOffer,
  type PairingRequest,
} from "../src/data/devicePairing";

const offer: PairingOffer = {
  protocolMajor: 2,
  deviceId: "550e8400-e29b-41d4-a716-446655440000",
  displayName: "Training Mac",
  identityPublicKey: "host-public-key",
  fingerprint: "host-fingerprint",
  token: "pairing-token",
  expiresAtMs: 1_800_000_000_000,
  libraries: [
    {
      syncLibraryId: "f42d5827-37b3-4809-9971-e968bf993a83",
      name: "Default database",
    },
  ],
};

const request: PairingRequest = {
  protocolMajor: 2,
  token: offer.token,
  hostDeviceId: offer.deviceId,
  peerDeviceId: "7b2cd5dc-c12c-43f6-86f6-4e3b51b0dc49",
  peerDisplayName: "Pixel 7",
  peerIdentityPublicKey: "peer-public-key",
  syncLibraryIds: [offer.libraries[0].syncLibraryId],
  signature: "pairing-signature",
};

describe("native device pairing facade", () => {
  beforeEach(() => {
    native.isTauri = true;
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(undefined);
  });

  it("maps the pairing and authentication workflow to native commands", async () => {
    await getDeviceIdentity();
    await createPairingOffer("Training Mac");
    await createPairingRequest(offer, "Pixel 7", request.syncLibraryIds);
    await completePairing(request);
    await trustPairingOffer(offer, request.syncLibraryIds);
    await listTrustedPeers();
    await renameTrustedPeer(request.peerDeviceId, "Mat phone");
    await revokeTrustedPeer(request.peerDeviceId);
    await generateAuthenticationChallenge();
    await signAuthenticationChallenge("challenge");
    await verifyTrustedPeerSignature(
      request.peerDeviceId,
      "challenge",
      "signature",
    );

    expect(native.invoke.mock.calls).toEqual([
      ["get_device_identity"],
      ["create_pairing_offer", { displayName: "Training Mac" }],
      [
        "create_pairing_request",
        {
          offer,
          peerDisplayName: "Pixel 7",
          syncLibraryIds: request.syncLibraryIds,
        },
      ],
      ["complete_pairing", { request }],
      [
        "trust_pairing_offer",
        { offer, syncLibraryIds: request.syncLibraryIds },
      ],
      ["list_trusted_peers"],
      [
        "rename_trusted_peer",
        { peerDeviceId: request.peerDeviceId, displayName: "Mat phone" },
      ],
      ["revoke_trusted_peer", { peerDeviceId: request.peerDeviceId }],
      ["generate_authentication_challenge"],
      ["sign_authentication_challenge", { challenge: "challenge" }],
      [
        "verify_trusted_peer_signature",
        {
          peerDeviceId: request.peerDeviceId,
          challenge: "challenge",
          signature: "signature",
        },
      ],
    ]);
  });

  it("rejects pairing calls in the browser fallback", async () => {
    native.isTauri = false;

    await expect(getDeviceIdentity()).rejects.toThrow(
      "Device pairing is available only in the native app",
    );
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
