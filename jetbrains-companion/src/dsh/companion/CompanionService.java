package dsh.companion;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.openapi.roots.ProjectRootManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.WindowManager;
import java.awt.Frame;
import java.io.IOException;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Application service that publishes this IDE's workspace to DSH: it owns the loopback
 * {@link BridgeServer}, the bearer token, and the {@link Descriptor} file, and it republishes the
 * snapshot whenever a consumer-visible field changes. It also creates or reuses each project's DSH
 * session over DSH's own HTTP API, which is what makes a project opened here a session of its own.
 *
 * The service starts once per IDE run, from {@link CompanionStartup}, and stops on shutdown.
 */
public final class CompanionService implements Disposable {
  private static final Logger LOG = Logger.getInstance(CompanionService.class);

  /** How often the IDE state is compared against the last published snapshot. */
  private static final long POLL_INTERVAL_MS = 500;

  private final Object lock = new Object();
  private final Path descriptorPath = Descriptor.path();
  private final ExecutorService sessionSync = Executors.newSingleThreadExecutor(runnable -> {
    Thread thread = new Thread(runnable, "dsh-companion-session");
    thread.setDaemon(true);
    return thread;
  });
  private BridgeServer server;
  private ScheduledExecutorService poller;
  private String token = "";
  private volatile String snapshotJson = "";
  private volatile String signature = "";
  private volatile Snapshot snapshot = new Snapshot();

  /** Start the bridge and the publisher; repeated calls are no-ops. */
  public void start() {
    synchronized (lock) {
      if (server != null) return;
      token = newToken();
      try {
        server = new BridgeServer(new BridgeServer.Ide() {
          @Override
          public String snapshotJson() {
            return CompanionService.this.snapshotJson;
          }

          @Override
          public String open(String requestPath, int line, int column) {
            return CompanionService.this.openInIde(requestPath, line, column);
          }
        }, token);
      } catch (IOException failure) {
        LOG.warn("dsh-companion: cannot bind the loopback bridge", failure);
        return;
      }
      Snapshot first = collectNow();
      if (first != null) publish(first);
      poller = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "dsh-companion-poller");
        thread.setDaemon(true);
        return thread;
      });
      poller.scheduleWithFixedDelay(this::poll, POLL_INTERVAL_MS, POLL_INTERVAL_MS, TimeUnit.MILLISECONDS);
      LOG.info("dsh-companion: bridge on 127.0.0.1:" + server.port() + ", descriptor " + descriptorPath);
    }
  }

  @Override
  public void dispose() {
    synchronized (lock) {
      if (poller != null) {
        poller.shutdownNow();
        poller = null;
      }
      if (server != null) {
        server.close();
        server = null;
      }
      Descriptor.delete(descriptorPath);
    }
    sessionSync.shutdownNow();
  }

  /** @return the application-wide service that publishes this IDE's workspace. */
  public static CompanionService getInstance() {
    return ApplicationManager.getApplication().getService(CompanionService.class);
  }

  /** @return whether the bridge is listening. */
  public boolean isRunning() {
    return server != null;
  }

  /**
   * The directory this project's DSH session runs in.
   *
   * With `Window session` on — the default — the whole IDE window shares one session at the shared
   * parent of its roots, which is also what the DSH-side plugin registers as the window workspace.
   * Without a usable shared parent, and with the setting off, each project keeps its own session in
   * its own directory.
   * @param project - the open project.
   * @return the absolute session directory, or {@code null} when the project has no base path.
   */
  public String sessionDirectory(Project project) {
    if (project == null) return null;
    String basePath = project.getBasePath();
    if (basePath == null) return null;
    boolean windowScope = DshCompanionSettings.getInstance().state().windowSession;
    Snapshot current = snapshot();
    String directory = SessionScope.directory(current, basePath, windowScope);
    if (windowScope && !SessionScope.describes(current, basePath)) {
      // A tool window can be created before the publisher's first poll, and then the window's roots
      // are unknown. One synchronous collection decides whether the window has a shared parent,
      // instead of quietly falling back to the narrower project directory.
      Snapshot collected = collectNow();
      if (collected != null) directory = SessionScope.directory(collected, basePath, true);
    }
    return directory;
  }

  /** @return the bridge address, the descriptor path, and the DSH session target, for a human. */
  public String status() {
    DshCompanionSettings.State settings = DshCompanionSettings.getInstance().state();
    String sessions = "\nDSH: " + DshSessions.describe(settings)
      + "\nSession per project: " + (settings.sessionOnProjectOpen ? "created or reused when a project opens" : "manual only");
    BridgeServer current = server;
    if (current == null) return "DSH Companion is not running." + sessions;
    return "DSH Companion bridge: http://127.0.0.1:" + current.port()
      + "\nDescriptor: " + descriptorPath
      + "\nToken: " + (token.isEmpty() ? "(none)" : "issued for this IDE run")
      + sessions;
  }

  /**
   * Create or reuse the DSH session of this project's window, on a background thread so no IDE action
   * waits on the network.
   * @param project - project whose window names the session.
   * @param manual - true when a human asked: report both outcomes and every failure.
   */
  void syncSession(Project project, boolean manual) {
    String directory = sessionDirectory(project);
    if (directory == null) return;
    sessionSync.execute(() -> {
      try {
        DshSessions.Outcome outcome = DshSessions.ensure(
          directory, DshCompanionSettings.getInstance().state(), project.getName());
        LOG.info("dsh-companion: " + (outcome.created ? "created" : "reusing") + " DSH session "
          + outcome.sessionId + " for " + directory);
        if (outcome.created || manual) {
          notify(
            "DSH session for " + project.getName(),
            (outcome.created ? "Created " : "Reusing ") + outcome.sessionId + "\n" + directory,
            false);
        }
      } catch (IOException failure) {
        LOG.info("dsh-companion: no DSH session for " + directory + ": " + failure.getMessage());
        if (manual) notify("DSH session unavailable", failure.getMessage(), true);
      }
    });
  }

  private static void notify(String title, String content, boolean warning) {
    NotificationGroupManager.getInstance()
      .getNotificationGroup("DshCompanion")
      .createNotification(title, content, warning ? NotificationType.WARNING : NotificationType.INFORMATION)
      .notify(null);
  }

  /** @return the newest workspace snapshot. */
  public Snapshot snapshot() {
    return snapshot;
  }

  private void poll() {
    Snapshot collected = collectNow();
    if (collected == null || collected.signature().equals(signature)) return;
    publish(collected);
  }

  private void publish(Snapshot collected) {
    BridgeServer current = server;
    if (current == null) return;
    snapshot = collected;
    signature = collected.signature();
    snapshotJson = collected.toJson();
    try {
      Descriptor.write(descriptorPath, Descriptor.document(current.port(), token, collected));
    } catch (IOException failure) {
      LOG.warn("dsh-companion: cannot write the descriptor " + descriptorPath, failure);
    }
  }

  private Snapshot collectNow() {
    if (ApplicationManager.getApplication() == null) return null;
    Snapshot[] holder = new Snapshot[1];
    Runnable task = () -> holder[0] = ReadAction.computeBlocking(CompanionCollector::collect);
    try {
      if (ApplicationManager.getApplication().isDispatchThread()) task.run();
      else ApplicationManager.getApplication().invokeAndWait(task);
    } catch (RuntimeException refused) {
      /* the IDE is shutting down or refusing new work; the previous snapshot stays published */
      return null;
    }
    return holder[0];
  }

  /**
   * Open one file in this IDE, focused, with an optional caret position.
   * @param requestPath - absolute file path, with either separator style.
   * @param line - one-based line, or 0.
   * @param column - one-based column, or 0.
   * @return a failure message, or {@code null} on success.
   */
  private String openInIde(String requestPath, int line, int column) {
    String normalized = requestPath.replace('\\', '/');
    String[] failure = new String[1];
    Runnable task = () -> ReadAction.runBlocking(() -> {
      Project target = projectFor(normalized);
      if (target == null) {
        failure[0] = "no open project accepts " + normalized;
        return;
      }
      VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(normalized);
      if (file == null) {
        failure[0] = "file not found: " + normalized;
        return;
      }
      OpenFileDescriptor descriptor =
        new OpenFileDescriptor(target, file, line > 0 ? line - 1 : 0, column > 0 ? column - 1 : 0);
      FileEditorManager.getInstance(target).openTextEditor(descriptor, true);
    });
    try {
      if (ApplicationManager.getApplication().isDispatchThread()) task.run();
      else ApplicationManager.getApplication().invokeAndWait(task);
    } catch (RuntimeException refused) {
      return "the IDE refused the request: " + refused.getMessage();
    }
    return failure[0];
  }

  private static Project projectFor(String path) {
    Project first = null;
    Project focused = null;
    for (Project project : ProjectManager.getInstance().getOpenProjects()) {
      if (project.isDefault()) continue;
      if (first == null) first = project;
      Frame frame = WindowManager.getInstance().getFrame(project);
      if (focused == null && frame != null && frame.isActive()) focused = project;
      for (VirtualFile root : ProjectRootManager.getInstance(project).getContentRoots()) {
        String rootPath = root.getPath();
        if (path.equals(rootPath) || path.startsWith(rootPath + "/")) return project;
      }
    }
    return focused != null ? focused : first;
  }

  private static String newToken() {
    byte[] bytes = new byte[24];
    new SecureRandom().nextBytes(bytes);
    return HexFormat.of().formatHex(bytes);
  }
}
