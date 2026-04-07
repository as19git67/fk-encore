import Foundation
import BackgroundTasks

/// Manages registration and scheduling of the background photo-sync processing task.
///
/// `register()` **must** be called from `application(_:didFinishLaunchingWithOptions:)`
/// before the app finishes launching, otherwise iOS will never invoke the handler.
public final class BackgroundSyncManager {
    public static let shared = BackgroundSyncManager()

    private init() {}

    // MARK: - Registration (call once at launch)

    public func register() {
        print("[BGSync] Registering task: \(PhotoSyncPreferences.taskIdentifier)")
        let ok = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: PhotoSyncPreferences.taskIdentifier,
            using: nil
        ) { [weak self] task in
            print("[BGSync] Handler called, task type: \(type(of: task))")
            guard let processingTask = task as? BGProcessingTask else {
                print("[BGSync] Cast to BGProcessingTask failed")
                task.setTaskCompleted(success: false)
                return
            }
            self?.handle(processingTask)
        }
        print("[BGSync] Registration result: \(ok)")
    }

    // MARK: - Scheduling

    /// Schedule the next sync run. Cancels any pending request if sync is disabled.
    public func scheduleNextSyncIfNeeded() {
        guard PhotoSyncPreferences.syncEnabled else {
            BGTaskScheduler.shared.cancel(
                taskRequestWithIdentifier: PhotoSyncPreferences.taskIdentifier
            )
            return
        }

        let request = BGProcessingTaskRequest(identifier: PhotoSyncPreferences.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        // Give the system at least 15 minutes before the task is eligible to run
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)

        do {
            try BGTaskScheduler.shared.submit(request)
            print("[BGSync] Task scheduled: \(PhotoSyncPreferences.taskIdentifier)")
        } catch {
            print("[BGSync] Failed to schedule task: \(error)")
        }
    }

    // MARK: - Task handler

    private func handle(_ task: BGProcessingTask) {
        print("[BGSync] Task handler invoked")
        // Re-schedule the next occurrence immediately so it's always queued
        scheduleNextSyncIfNeeded()

        let work = Task {
            do {
                try await PhotoSyncService.shared.sync()
                task.setTaskCompleted(success: true)
            } catch {
                task.setTaskCompleted(success: false)
            }
        }

        task.expirationHandler = {
            work.cancel()
            task.setTaskCompleted(success: false)
        }
    }
}
