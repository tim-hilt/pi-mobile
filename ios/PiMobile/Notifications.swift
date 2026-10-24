import Foundation
import Observation
import UserNotifications

/// Where the bridge publishes "run settled" announcements: a topic on an ntfy server.
/// The bridge tells the app on every `hello`, so the app never configures it.
struct NtfyTopic: Codable, Equatable, Sendable {
  let baseUrl: URL
  let topic: String

  /// ntfy's live WebSocket stream of the topic.
  var streamURL: URL {
    var parts = URLComponents(url: baseUrl, resolvingAgainstBaseURL: false) ?? URLComponents()
    parts.scheme = ["http", "ws"].contains(parts.scheme) ? "ws" : "wss"
    let segments = [parts.path, topic, "ws"].map { $0.trimmingCharacters(in: ["/"]) }.filter { !$0.isEmpty }
    parts.path = "/" + segments.joined(separator: "/")
    return parts.url ?? baseUrl
  }
}

/// One settled run, as the bridge announces it. Never contains transcript content.
struct RunSettledNotice: Equatable, Sendable {
  let sessionId: String
  /// Nil while the session has no user-given name.
  let sessionName: String?
  let stopReason: Transcript.StopReason
  let durationMs: Int

  init(sessionId: String, sessionName: String?, stopReason: Transcript.StopReason, durationMs: Int) {
    self.sessionId = sessionId
    self.sessionName = sessionName
    self.stopReason = stopReason
    self.durationMs = durationMs
  }

  /// The notice an ntfy WebSocket frame carries, or nil for anything else on the topic
  /// (`open` and `keepalive` frames, messages published by other tools).
  init?(ntfyFrame frame: String) {
    struct Frame: Decodable {
      let event: String
      let message: String?
    }
    struct Body: Decodable {
      let sessionId: String
      let sessionName: String?
      let stopReason: String
      let durationMs: Int
    }
    guard let outer = try? JSONDecoder().decode(Frame.self, from: Data(frame.utf8)), outer.event == "message",
      let message = outer.message,
      let body = try? JSONDecoder().decode(Body.self, from: Data(message.utf8))
    else { return nil }
    self.init(
      sessionId: body.sessionId, sessionName: body.sessionName,
      // A reason this app does not know is surfaced as an error, as in the transcript.
      stopReason: Transcript.StopReason(rawValue: body.stopReason) ?? .error, durationMs: body.durationMs)
  }

  /// The local notification to raise; its `userInfo["sessionId"]` is what a tap opens.
  var notificationContent: UNNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = sessionName ?? "Session"
    content.body = "\(stopReason.label) · \(format(durationMs: durationMs))"
    content.sound = .default
    content.userInfo = ["sessionId": sessionId]
    return content
  }
}

extension Transcript.StopReason {
  /// How a finished run is described to the user.
  var label: String {
    switch self {
    case .success: "Finished"
    case .error: "Failed"
    case .aborted: "Aborted"
    case .length: "Cut off: output limit reached"
    }
  }
}

/// Live subscription to an ntfy topic.
enum NtfyStream {
  /// Reports every settled run published to `topic` until the calling task is cancelled,
  /// reconnecting after `retryDelay` when the stream drops. Runs that settle while no stream
  /// is open are not replayed.
  static func listen(
    to topic: NtfyTopic, retryDelay: Duration = .seconds(5),
    onNotice: @MainActor (RunSettledNotice) -> Void
  ) async {
    while !Task.isCancelled {
      let socket = URLSession.shared.webSocketTask(with: topic.streamURL)
      await withTaskCancellationHandler {
        socket.resume()
        while let message = try? await socket.receive() {
          if case .string(let frame) = message, let notice = RunSettledNotice(ntfyFrame: frame) {
            await onNotice(notice)
          }
        }
      } onCancel: {
        socket.cancel(with: .goingAway, reason: nil)
      }
      socket.cancel(with: .goingAway, reason: nil)
      try? await Task.sleep(for: retryDelay)
    }
  }
}

/// Raises a local notification for every settled run on the topic and remembers which session
/// the user opened by tapping one.
@MainActor @Observable
final class SettleNotifications: NSObject, UNUserNotificationCenterDelegate {
  /// The session of the notification the user tapped; whoever opens it sets this back to nil.
  var requestedSession: String?

  @ObservationIgnored private let center = UNUserNotificationCenter.current()

  override init() {
    super.init()
    center.delegate = self
  }

  /// Notifies about runs settling on `topic` until the calling task is cancelled.
  func listen(to topic: NtfyTopic) async {
    _ = try? await center.requestAuthorization(options: [.alert, .sound])
    await NtfyStream.listen(to: topic) { [center] notice in
      center.add(UNNotificationRequest(identifier: UUID().uuidString, content: notice.notificationContent, trigger: nil))
    }
  }

  /// The app is active while listening, so the banner is shown rather than suppressed.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    guard let id = response.notification.request.content.userInfo["sessionId"] as? String else { return }
    await MainActor.run { requestedSession = id }
  }
}
