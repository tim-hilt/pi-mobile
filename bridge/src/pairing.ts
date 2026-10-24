import qrcode from "qrcode-terminal";

/** What the pairing QR code carries; the app parses it in `BridgeConfig(pairingURL:)`. */
export function pairingUrl(publicUrl: string, token: string): string {
  const url = new URL("pimobile://connect");
  url.searchParams.set("url", publicUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** The pairing QR code as terminal text. */
export function pairingQr(publicUrl: string, token: string): string {
  let out = "";
  qrcode.generate(pairingUrl(publicUrl, token), { small: true }, (qr) => {
    out = qr;
  });
  return out;
}
