import { invoke, isTauri } from "@tauri-apps/api/core";

export interface DeviceIdentity {
  deviceId: string;
  identityPublicKey: string;
  fingerprint: string;
}

export interface PairingLibrary {
  syncLibraryId: string;
  name: string;
}

export interface PairingOffer {
  protocolMajor: number;
  deviceId: string;
  displayName: string;
  identityPublicKey: string;
  fingerprint: string;
  token: string;
  expiresAtMs: number;
  libraries: PairingLibrary[];
}

export interface PairingRequest {
  protocolMajor: number;
  token: string;
  hostDeviceId: string;
  peerDeviceId: string;
  peerDisplayName: string;
  peerIdentityPublicKey: string;
  syncLibraryIds: string[];
  signature: string;
}

export interface TrustedPeer {
  deviceId: string;
  displayName: string;
  identityPublicKey: string;
  fingerprint: string;
  syncLibraryIds: string[];
  trustedAt: string;
  revoked: boolean;
  baseUrl: string | null;
}

function requireNativePairing() {
  if (!isTauri()) {
    throw new Error("Device pairing is available only in the native app");
  }
}

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  requireNativePairing();
  return invoke<DeviceIdentity>("get_device_identity");
}

export async function createPairingOffer(
  displayName: string,
): Promise<PairingOffer> {
  requireNativePairing();
  return invoke<PairingOffer>("create_pairing_offer", { displayName });
}

export async function createPairingRequest(
  offer: PairingOffer,
  peerDisplayName: string,
  syncLibraryIds: string[],
): Promise<PairingRequest> {
  requireNativePairing();
  return invoke<PairingRequest>("create_pairing_request", {
    offer,
    peerDisplayName,
    syncLibraryIds,
  });
}

export async function completePairing(
  request: PairingRequest,
): Promise<TrustedPeer> {
  requireNativePairing();
  return invoke<TrustedPeer>("complete_pairing", { request });
}

export async function trustPairingOffer(
  offer: PairingOffer,
  syncLibraryIds: string[],
): Promise<TrustedPeer> {
  requireNativePairing();
  return invoke<TrustedPeer>("trust_pairing_offer", { offer, syncLibraryIds });
}

export async function listTrustedPeers(): Promise<TrustedPeer[]> {
  requireNativePairing();
  return invoke<TrustedPeer[]>("list_trusted_peers");
}

export async function renameTrustedPeer(
  peerDeviceId: string,
  displayName: string,
): Promise<TrustedPeer> {
  requireNativePairing();
  return invoke<TrustedPeer>("rename_trusted_peer", {
    peerDeviceId,
    displayName,
  });
}

export async function revokeTrustedPeer(
  peerDeviceId: string,
): Promise<boolean> {
  requireNativePairing();
  return invoke<boolean>("revoke_trusted_peer", { peerDeviceId });
}

export async function generateAuthenticationChallenge(): Promise<string> {
  requireNativePairing();
  return invoke<string>("generate_authentication_challenge");
}

export async function signAuthenticationChallenge(
  challenge: string,
): Promise<string> {
  requireNativePairing();
  return invoke<string>("sign_authentication_challenge", { challenge });
}

export async function verifyTrustedPeerSignature(
  peerDeviceId: string,
  challenge: string,
  signature: string,
): Promise<boolean> {
  requireNativePairing();
  return invoke<boolean>("verify_trusted_peer_signature", {
    peerDeviceId,
    challenge,
    signature,
  });
}
