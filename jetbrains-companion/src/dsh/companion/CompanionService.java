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
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationAction;
import com.intellij.notification.Notifications;
import com.intellij.openapi.actionSystem.AnActionEvent;
import org.jetbrains.annotations.NotNull;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;

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
    // Turns published while this IDE was closed are worth mentioning before anything else starts.
    notifyMissedTurns();
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

          @Override
          public String changed(String body) {
            return CompanionService.this.changedInIde(body);
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
  /**
   * Mention the turns that were published while this IDE was closed.
   *
   * The review document outlives the IDE, so history is never lost; what was missing was being told. The
   * watermark lives in the plugin's settings, so one turn is mentioned once.
   */
  private void notifyMissedTurns() {
    long newest = 0;
    int missed = 0;
    String latest = null;
    try {
      for (DshChanges.Turn turn : DshChanges.read(DshChanges.path())) {
        if (turn.at() <= 0) continue;
        newest = Math.max(newest, turn.at());
        if (turn.at() > DshCompanionSettings.getInstance().state().lastSeenChangesAt) {
          missed += 1;
          if (latest == null && !turn.files().isEmpty()) latest = turn.files().get(0).display();
        }
      }
    } catch (IOException unavailable) {
      LOG.info("dsh-companion: nothing to catch up on: " + unavailable.getMessage());
      return;
    }
    if (missed == 0) return;
    DshCompanionSettings.getInstance().state().lastSeenChangesAt = newest;
    Notification notification = new Notification("DshCompanion",
      "DSH changed files while the IDE was closed",
      missed + (missed == 1 ? " turn" : " turns") + " since you last looked"
        + (latest == null ? "" : ", latest " + latest),
      NotificationType.INFORMATION);
    notification.addAction(new NotificationAction("Show changes") {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event, @NotNull Notification shown) {
        shown.expire();
        for (Project project : ProjectManager.getInstance().getOpenProjects()) {
          if (project.isDefault()) continue;
          ToolWindow window = ToolWindowManager.getInstance(project)
            .getToolWindow(DshDiffToolWindowFactory.TOOL_WINDOW_ID);
          if (window != null) window.show();
        }
      }
    });
    Notifications.Bus.notify(notification);
  }

  /**
   * Show the diff of a turn DSH just published, and offer to keep or revert it.
   *
   * The diff comes from DSH, which holds the recorder, so the lookup happens off the bridge thread; the tab
   * and the notification belong on the dispatch thread.
   *
   * @param body - the JSON notice.
   * @return a failure message, or null when the IDE took it.
   */
  private String changedInIde(String body) {
    Object parsed = JsonParser.parse(body);
    String sessionId = JsonParser.string(parsed, "sessionId");
    Object rawSeq = JsonParser.member(parsed, "seq");
    if (sessionId == null || !(rawSeq instanceof Long seq)) return "the notice names no session or sequence";
    List<Object> files = JsonParser.array(parsed, "files");
    if (files.isEmpty()) return "the turn changed no file";
    Object first = files.get(0);
    String path = JsonParser.string(first, "path");
    if (path == null || path.isEmpty()) return "the turn named no file path";
    String display = JsonParser.string(first, "display");
    String cwd = JsonParser.string(parsed, "cwd");
    Object rawTurn = JsonParser.member(parsed, "turn");
    int turn = rawTurn instanceof Long number ? number.intValue() : 0;
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
      ChangesDiff diff;
      try {
        DshCompanionSettings.State settings = DshCompanionSettings.getInstance().state();
        DshClient client = DshClient.locate(DshSessions.candidateUrls(settings), DshSessions.candidateHomes(settings));
        diff = client.changesDiff(sessionId, seq, 0);
      } catch (IOException failure) {
        LOG.info("dsh-companion: cannot read the diff DSH announced: " + failure.getMessage());
        return;
      }
      ApplicationManager.getApplication().invokeLater(() -> showChangedDiff(diff, display, cwd, turn));
    });
    return null;
  }

  /**
   * Open one announced change as a native diff, with the two answers a reader has.
   *
   * @param diff - the payload DSH served.
   * @param display - the name to show.
   * @param cwd - the workspace root the payload's path is relative to.
   * @param turn - the turn number.
   */
  private void showChangedDiff(ChangesDiff diff, String display, String cwd, int turn) {
    Project project = null;
    for (Project candidate : ProjectManager.getInstance().getOpenProjects()) {
      if (!candidate.isDefault()) {
        project = candidate;
        break;
      }
    }
    if (project == null) return;
    DiffContentFactory factory = DiffContentFactory.getInstance();
    DiffManager.getInstance().showDiff(project, new SimpleDiffRequest(
      diff.title() + "  ·  DSH turn " + turn,
      factory.create(diff.left()),
      factory.create(diff.right()),
      "before this turn",
      "after this turn"));
    String name = display == null || display.isEmpty() ? diff.path() : display;
    Notification notification = new Notification("DshCompanion", "DSH changed " + name,
      "Turn " + turn + " · " + diff.hunkCount() + (diff.hunkCount() == 1 ? " hunk" : " hunks")
        + " · keep it or take it back",
      NotificationType.INFORMATION);
    notification.addAction(new NotificationAction("Keep") {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event, @NotNull Notification shown) {
        shown.expire();
      }
    });
    notification.addAction(new NotificationAction("Revert") {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event, @NotNull Notification shown) {
        shown.expire();
        revertChanged(diff, cwd);
      }
    });
    Notifications.Bus.notify(notification, project);
  }

  /**
   * Take one announced change back, the same way the changes panel does.
   *
   * @param diff - the payload DSH served.
   * @param cwd - the workspace root the payload's path is relative to.
   */
  private void revertChanged(ChangesDiff diff, String cwd) {
    Path file = Path.of(cwd == null ? "" : cwd, diff.path() == null ? "" : diff.path());
    try {
      if (diff.isCreation()) {
        Files.deleteIfExists(file);
        return;
      }
      Files.writeString(file, ChangesRevert.reverted(Files.readString(file, StandardCharsets.UTF_8), diff),
        StandardCharsets.UTF_8);
    } catch (IOException | ChangesRevert.Refused failure) {
      LOG.warn("dsh-companion: cannot revert " + file + ": " + failure.getMessage());
      Notifications.Bus.notify(new Notification("DshCompanion", "DSH could not revert " + diff.path(),
        String.valueOf(failure.getMessage()), NotificationType.WARNING));
    }
  }

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
