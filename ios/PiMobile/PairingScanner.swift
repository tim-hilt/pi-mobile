import SwiftUI
import VisionKit

/// Sheet with a camera view that reads the bridge's pairing QR code and hands over its config.
struct PairingScanner: View {
  let onScan: (BridgeConfig) -> Void

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
          QRScanner { code in
            guard let url = URL(string: code), case .pair(let config)? = DeepLink(url: url) else { return }
            onScan(config)
            dismiss()
          }
          .ignoresSafeArea()
        } else {
          ContentUnavailableView(
            "Camera unavailable", systemImage: "camera.fill",
            description: Text("Allow camera access for Pi Mobile in Settings."))
        }
      }
      .navigationTitle("Scan QR Code")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
    }
  }
}

private struct QRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let onCode: (String) -> Void
    init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
      for case .barcode(let barcode) in items {
        if let code = barcode.payloadStringValue { onCode(code) }
      }
    }
  }
}
