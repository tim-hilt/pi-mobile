import qrcode from "qrcode-terminal";

/** What the pairing QR code carries; the app parses it in `BridgeConfig(pairingURL:)`. */
export function pairingUrl(publicUrl: string, token: string): string {
  const url = new URL("pimobile://connect");
  url.searchParams.set("url", publicUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** A pairing URL as a terminal QR code. */
export function pairingQr(url: string): string {
  let out = "";
  qrcode.generate(url, { small: true }, (qr) => {
    out = qr;
  });
  return out;
}
