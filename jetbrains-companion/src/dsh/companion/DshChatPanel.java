package dsh.companion;

import com.intellij.icons.AllIcons;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionToolbar;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.DefaultActionGroup;
import com.intellij.openapi.actionSystem.Separator;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.text.StringUtil;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefCookie;
import com.intellij.ui.jcef.JBCefCookieManager;
import com.intellij.util.ui.JBUI;
import java.awt.BorderLayout;
import java.awt.CardLayout;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Date;
import java.util.List;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.swing.JButton;
import javax.swing.Timer;
import javax.swing.JComponent;
import javax.swing.JPanel;
import javax.swing.SwingConstants;
import org.cef.CefSettings;
import org.cef.handler.CefDisplayHandlerAdapter;
import org.cef.handler.CefLoadHandler;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;

/**
 * The DSH Chat tool window: DSH's own web client embedded in the IDE through JCEF.
 *
 * The panel authenticates that embedded browser exactly as DSH authenticates a real one — it signs
 * the same `dsh-auth-*` browser-session cookie from the credential document, hands it to the browser
 * before the first navigation, and then loads the DSH address the companion already discovers. No
 * other IDE plugin, no DSH-side plugin, and no external browser is involved, and the panel works the
 * same whether DSH was started by the IDE or from a terminal.
 *
 * DSH not running, or a missing credential document, is a normal state: the panel shows what is
 * wrong and offers Retry instead of failing the tool window.
 */
final class DshChatPanel extends JPanel implements Disposable {
  private static final Logger LOG = Logger.getInstance(DshChatPanel.class);

  /** Card holding the embedded browser. */
  private static final String CARD_BROWSER = "browser";

  /** Card holding the connecting or failure message. */
  private static final String CARD_MESSAGE = "message";

  /** How long the browser cookie is allowed to take before the page loads without it. */
  private static final long COOKIE_TIMEOUT_SECONDS = 3;

  /** How long the panel waits for JCEF's connection to cef_server before reporting it as unready. */
  private static final long COOKIE_WAIT_MILLIS = 15_000;

  /** Delay between attempts to store the cookie while JCEF is still starting. */
  private static final long COOKIE_RETRY_MILLIS = 200;

  /**
   * How many times the panel re-asks the embedded client for this session.
   *
   * One push is not enough: the client clears its saved selection when a restoration attempt fails or
   * when the user starts a new session, and the panel would then keep watching a session the client
   * no longer displays. Repeating is safe because the script reloads only when the record differs,
   * and the bound stops a client that clears on every boot from reloading forever.
   */
  private static final int SELECTION_PUSH_LIMIT = 3;

  /**
   * How long the toolbar action gives a session-link client plugin to answer the fragment before it
   * falls back to the client's own recorded selection.
   *
   * That ask goes to a page that is already up, which is the case the fragment path is for: a page
   * that just booted has a client without its workspace data, and the plugin refuses the open there.
   */
  private static final int WARM_LINK_FALLBACK_MILLIS = 1_500;

  /** How long the diagnostic probe waits, so it reads a page that has settled. */
  private static final int PROBE_DELAY_MILLIS = 3_000;

  /**
   * Whether to report the embedded page's link state into the IDE log. Off unless the IDE is launched
   * with {@code DSH_COMPANION_PROBE} set; the probe reads and never writes.
   */
  private static final boolean PROBE = System.getenv("DSH_COMPANION_PROBE") != null;

  /** How many fragment asks one panel connection may make, so a client that never answers stops. */
  private static final int SELECTION_LINK_LIMIT = 12;

  private final Project project;
  private final CardLayout cards = new CardLayout();
  private final JPanel body = new JPanel(cards);
  private final JBLabel message = new JBLabel("", SwingConstants.CENTER);
  private final JButton retry = new JButton("Retry");

  private JBCefBrowser browser;
  private String baseUrl;
  private String sessionId;
  private int selectionPushes;
  private int linkAttempts;
  private boolean connected;
  private volatile boolean disposed;

  /**
   * @param project - project owning the tool window; its working directory names the DSH session the
   *     panel shows.
   */
  DshChatPanel(Project project) {
    super(new BorderLayout());
    this.project = project;
    add(toolbar(), BorderLayout.NORTH);
    body.add(messageCard(), CARD_MESSAGE);
    add(body, BorderLayout.CENTER);
    connect();
  }

  /** @return the `DSH Chat` toolbar row. */
  private JComponent toolbar() {
    DefaultActionGroup group = new DefaultActionGroup();
    group.add(new DumbAwareAction("Reload", "Reload the DSH page, or reconnect when it never loaded", AllIcons.Actions.Refresh) {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event) {
        reload();
      }
    });
    group.add(new DumbAwareAction("Home", "Open the DSH home page", AllIcons.General.Web) {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event) {
        navigate(baseUrl);
      }
    });
    group.add(new DumbAwareAction("This Project's Session",
        "Show the DSH session whose working directory is this project", AllIcons.Nodes.Project) {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event) {
        showProjectSession();
      }
    });
    group.add(new Separator());
    group.add(new DumbAwareAction("Back", "Go back in the DSH client", AllIcons.Actions.Back) {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event) {
        if (cef() != null) cef().goBack();
      }
    });
    group.add(new DumbAwareAction("Forward", "Go forward in the DSH client", AllIcons.Actions.Forward) {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event) {
        if (cef() != null) cef().goForward();
      }
    });
    group.add(new Separator());
    group.add(new DumbAwareAction("Open in Browser", "Open this DSH address in the system browser", AllIcons.Actions.OpenNewTab) {
      @Override
      public void actionPerformed(@NotNull AnActionEvent event) {
        BrowserUtil.browse(baseUrl == null ? "http://127.0.0.1:3080" : baseUrl);
      }
    });
    ActionToolbar toolbar = ActionManager.getInstance().createActionToolbar("DshChatToolbar", group, true);
    toolbar.setTargetComponent(this);
    JComponent component = toolbar.getComponent();
    component.setBorder(JBUI.Borders.empty(2, 4));
    return component;
  }

  /** @return the centered message card, with the Retry button below the message. */
  private JComponent messageCard() {
    JPanel panel = new JPanel(new GridBagLayout());
    GridBagConstraints constraints = new GridBagConstraints();
    constraints.gridx = 0;
    constraints.gridy = 0;
    constraints.insets = JBUI.insets(6);
    message.setBorder(JBUI.Borders.empty(0, 16));
    panel.add(message, constraints);
    constraints.gridy = 1;
    retry.addActionListener(event -> connect());
    panel.add(retry, constraints);
    return panel;
  }

  /**
   * Resolve the DSH address, authenticate against it, resolve this project's session, and load DSH
   * in the embedded browser.
   *
   * Discovery, authentication, and session resolution all touch the network, so they run on a pooled
   * thread; only building the browser and navigating happen on the EDT.
   */
  private void connect() {
    if (disposed) return;
    DshCompanionSettings.State settings = DshCompanionSettings.getInstance().state();
    List<String> candidates = DshSessions.candidateUrls(settings);
    List<Path> homes = DshSessions.candidateHomes(settings);
    connected = false;
    selectionPushes = 0;
    linkAttempts = 0;
    showMessage("Connecting to DSH…", false);
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
      try {
        DshClient client = DshClient.locate(candidates, homes);
        // The cookie must be signed by the same home that just authenticated, never by a guess.
        DshClient.Cookie cookie = client.browserCookie();
        String target = projectSession(client);
        ApplicationManager.getApplication().invokeLater(() -> open(client.baseUrl(), cookie, target));
      } catch (IOException failure) {
        LOG.info("dsh-companion: chat cannot reach DSH: " + failure.getMessage());
        ApplicationManager.getApplication().invokeLater(() -> showMessage(
          "DSH is not reachable.\n" + failure.getMessage() + "\n\nStart DSH, then press Retry.", true));
      }
    });
  }

  /**
   * Resolve — creating it when the window has none — the DSH session this panel shows: the window's
   * shared session with `Window session` on, else the project's own.
   * @param client - the authenticated client.
   * @return the session id, or {@code null} when the project has no directory or DSH refused.
   */
  private String projectSession(DshClient client) {
    String directory = CompanionService.getInstance().sessionDirectory(project);
    if (directory == null) return null;
    try {
      DshSessions.Outcome outcome = DshSessions.ensure(client, directory, project.getName());
      LOG.info("dsh-companion: chat targets " + outcome.sessionId + " (" + (outcome.created ? "created" : "reused")
        + ") for " + directory);
      return outcome.sessionId;
    } catch (IOException failure) {
      LOG.info("dsh-companion: chat cannot resolve the session for " + directory + ": " + failure.getMessage());
      return null;
    }
  }

  /**
   * Put the signed cookie into the embedded browser's cookie store, then load DSH.
   * @param url - the DSH base URL the cookie is signed for.
   * @param cookie - the browser-session cookie.
   * @param projectSessionId - the project's session the client should show, or {@code null}.
   */
  private void open(String url, DshClient.Cookie cookie, String projectSessionId) {
    if (disposed) return;
    try {
      baseUrl = url;
      sessionId = projectSessionId;
      JBCefBrowser target = browser();
      if (target == null) {
        showMessage("This IDE has no embedded browser (JCEF), so the DSH chat panel cannot render.\n"
          + "Reopen it in the system browser with the toolbar's Open in Browser action.", true);
        return;
      }
      connected = true;
      cards.show(body, CARD_BROWSER);
      ApplicationManager.getApplication().executeOnPooledThread(() -> {
        if (!storeCookie(target, url, cookie)) {
          ApplicationManager.getApplication().invokeLater(() -> showMessage(
            "The embedded browser did not finish starting, so DSH was never asked for a page.\n"
              + "Press Retry to try again.", true));
          return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
          if (!disposed) target.loadURL(url);
        });
      });
    } catch (RuntimeException | LinkageError failure) {
      // A panel that silently stays on "Connecting…" is worse than one that says what broke.
      LOG.warn("dsh-companion: the chat panel could not open DSH", failure);
      showMessage("The embedded browser could not open DSH.\n" + failure.getMessage()
        + "\n\nPress Retry to try again.", true);
    }
  }

  /**
   * Put the cookie in the embedded browser's store, waiting out JCEF's asynchronous startup.
   *
   * Creating the browser eagerly creates its object, not its connection: the native link to
   * `cef_server` is established in the background, and a cookie write before that link exists
   * throws. The page must never be loaded first, because an unauthenticated load is refused.
   * @param target - the embedded browser.
   * @param url - the DSH URL the cookie belongs to.
   * @param cookie - the signed browser-session cookie.
   * @return true when the cookie was stored, false when JCEF stayed unready for the whole deadline.
   */
  private boolean storeCookie(JBCefBrowser target, String url, DshClient.Cookie cookie) {
    Date now = new Date();
    JBCefCookie cefCookie = new JBCefCookie(
      cookie.name(),
      cookie.value(),
      cookie.host(),
      "/",
      false,
      true,
      now,
      now,
      true,
      new Date(cookie.expiresAt()));
    long deadline = System.currentTimeMillis() + COOKIE_WAIT_MILLIS;
    RuntimeException lastFailure = null;
    while (!disposed) {
      try {
        Future<Boolean> applied = target.getJBCefCookieManager().setCookie(url, cefCookie);
        try {
          applied.get(COOKIE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception ignored) {
          /* a refused cookie still loads the page, which then reports the authorization state */
        }
        return true;
      } catch (RuntimeException notReady) {
        lastFailure = notReady;
        if (System.currentTimeMillis() >= deadline) break;
        try {
          Thread.sleep(COOKIE_RETRY_MILLIS);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          break;
        }
      }
    }
    LOG.warn("dsh-companion: the embedded browser stayed unready for " + COOKIE_WAIT_MILLIS + " ms", lastFailure);
    return false;
  }

  /** @return the embedded browser, created on first use, or {@code null} when JCEF is unavailable. */
  private JBCefBrowser browser() {
    if (browser != null) return browser;
    if (!JBCefApp.isSupported()) return null;
    try {
      // Created immediately so the cookie store exists before the first navigation and DSH never
      // sees an unauthenticated request.
      JBCefBrowser created = JBCefBrowser.createBuilder().setCreateImmediately(true).build();
      // The embedded client reports a failed session restoration through its console, which reaches
      // idea.log only through this handler; without it a panel stuck on the workspace picker explains
      // nothing anywhere.
      created.getJBCefClient().addDisplayHandler(new CefDisplayHandlerAdapter() {
        @Override
        public boolean onConsoleMessage(org.cef.browser.CefBrowser cefBrowser, CefSettings.LogSeverity level,
            String message, String source, int line) {
          if (level == CefSettings.LogSeverity.LOGSEVERITY_ERROR) {
            LOG.warn("dsh-companion: client console " + source + ":" + line + " " + message);
          } else if (level == CefSettings.LogSeverity.LOGSEVERITY_WARNING) {
            LOG.info("dsh-companion: client console " + source + ":" + line + " " + message);
          }
          return false;
        }
      }, created.getCefBrowser());
      created.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
        @Override
        public void onLoadError(org.cef.browser.CefBrowser cefBrowser, org.cef.browser.CefFrame frame,
            CefLoadHandler.ErrorCode code, String errorText, String failedUrl) {
          if (frame == null || !frame.isMain()) return;
          // A reload aborts the navigation it replaces; that is not a failure worth reporting.
          if (code == CefLoadHandler.ErrorCode.ERR_ABORTED || code == CefLoadHandler.ErrorCode.ERR_NONE) return;
          LOG.warn("dsh-companion: the embedded browser could not load " + failedUrl
            + " (" + code + ": " + errorText + ")");
          ApplicationManager.getApplication().invokeLater(() -> {
            if (disposed) return;
            showMessage("The embedded browser could not load " + failedUrl + "\n" + errorText
              + "\n\nPress Retry to try again.", true);
          });
        }

        @Override
        public void onLoadEnd(org.cef.browser.CefBrowser cefBrowser, org.cef.browser.CefFrame frame, int httpStatusCode) {
          if (frame == null || !frame.isMain()) return;
          if (httpStatusCode == 401 || httpStatusCode == 403) {
            LOG.info("dsh-companion: the embedded browser was refused (" + httpStatusCode + ")");
            ApplicationManager.getApplication().invokeLater(() -> showMessage(
              "DSH refused the embedded browser's session cookie (HTTP " + httpStatusCode + ").\n"
                + "Check the DSH home setting, then press Retry.", true));
            return;
          }
          // Only a served page has a client to steer; the seeding script is idempotent, so the
          // reload it triggers once cannot start a loop.
          if (httpStatusCode == 200) selectProjectSession(cefBrowser);
        }
      }, created.getCefBrowser());
      browser = created;
      body.add(created.getComponent(), CARD_BROWSER);
      return created;
    } catch (RuntimeException | LinkageError failure) {
      LOG.warn("dsh-companion: the embedded browser could not be created", failure);
      return null;
    }
  }

  /** Reload the loaded page, or reconnect when DSH was never reached. */
  private void reload() {
    if (connected && cef() != null) cef().reload();
    else connect();
  }

  /** Navigate the embedded browser, reconnecting when there is nothing to navigate yet. */
  private void navigate(String url) {
    if (url == null) connect();
    else if (cef() != null) cef().loadURL(url);
  }

  /** @return the embedded CEF browser, or {@code null} when the panel has none yet. */
  private org.cef.browser.CefBrowser cef() {
    JBCefBrowser target = browser;
    return target == null || !target.isCefBrowserCreated() ? null : target.getCefBrowser();
  }

  /**
   * Ask the embedded client to show this project's session, through the client's own persisted
   * selection.
   *
   * It runs after every served page load but hands the client one session id at most once, so the
   * single reload that changes the selection happens exactly once and the panel never fights the
   * user's own navigation afterwards.
   *
   * This is the cold path: a page that just booted has a client without its workspace data yet, so
   * the fragment path cannot answer here (the session-link plugin refuses with
   * `sessions.retain: unknown session`). The warm path is {@link #showProjectSession()}, where a human
   * asks a page that is already up.
   * @param cef - the loaded browser.
   */
  private void selectProjectSession(org.cef.browser.CefBrowser cef) {
    final String target = sessionId;
    if (target == null || selectionPushes >= SELECTION_PUSH_LIMIT) return;
    selectionPushes++;
    runOnPage(DshSessionSelection.script(target));
    LOG.info("dsh-companion: chat asked the embedded client for session " + target
      + " (stored selection, push " + selectionPushes + "/" + SELECTION_PUSH_LIMIT + ")");
    if (PROBE) retry("chat probed the page", PROBE_DELAY_MILLIS, () -> runOnPage(DshSessionSelection.probeScript(sessionId)));
  }

  /**
   * Run one script on the current page, if there is one.
   * @param script - JavaScript to run in the loaded page.
   */
  private void runOnPage(String script) {
    org.cef.browser.CefBrowser page = cef();
    if (page == null) return;
    page.executeJavaScript(script, page.getURL(), 0);
  }

  /**
   * Ask once through the URL fragment, the reload-free path a session-link client plugin answers.
   * @param browser - the loaded page, or {@code null} when the panel has none.
   * @param target - session the client should show.
   * @param what - short description for the log line.
   */
  private void askThroughFragment(org.cef.browser.CefBrowser browser, String target, String what) {
    if (browser == null || linkAttempts >= SELECTION_LINK_LIMIT) return;
    linkAttempts++;
    browser.executeJavaScript(DshSessionSelection.linkScript(target, linkAttempts), browser.getURL(), 0);
    LOG.info("dsh-companion: chat asked the embedded client for session " + target
      + " (deep link, " + what + ")");
  }

  /**
   * Run one delayed step on the EDT, still only while this panel shows the same project session.
   * @param what - log line describing the step before it runs.
   * @param delayMillis - delay from now.
   * @param step - the work to run.
   */
  private void retry(String what, int delayMillis, Runnable step) {
    Timer timer = new Timer(delayMillis, event -> {
      if (disposed || cef() == null) return;
      LOG.info("dsh-companion: " + what);
      step.run();
    });
    timer.setRepeats(false);
    timer.start();
  }

  /** Toolbar action: re-resolve this project's session and show it, whatever the client displays now. */
  private void showProjectSession() {
    if (cef() == null) {
      connect();
      return;
    }
    if (sessionId == null) {
      // The project's session may exist now even though it did not when the panel connected.
      ApplicationManager.getApplication().executeOnPooledThread(() -> {
        try {
          String target = projectSession(DshClient.locate(
            DshSessions.candidateUrls(DshCompanionSettings.getInstance().state()),
            DshSessions.candidateHomes(DshCompanionSettings.getInstance().state())));
          ApplicationManager.getApplication().invokeLater(() -> {
            sessionId = target;
            selectionPushes = 0;
            linkAttempts = 0;
            if (cef() != null) selectProjectSession(cef());
          });
        } catch (IOException failure) {
          LOG.info("dsh-companion: chat cannot resolve this project's session: " + failure.getMessage());
        }
      });
      return;
    }
    // Warm page, human asking: the fragment path can answer here without a reload, and the stored
    // selection follows only if it did not (its script is idempotent, so a client already showing the
    // session is never reloaded).
    selectionPushes = 0;
    linkAttempts = 0;
    final String wanted = sessionId;
    askThroughFragment(cef(), wanted, "toolbar action");
    if (PROBE) retry("chat probed the page after the toolbar ask", PROBE_DELAY_MILLIS,
      () -> runOnPage(DshSessionSelection.probeScript(sessionId)));
    retry("chat checked the stored selection for session " + wanted, WARM_LINK_FALLBACK_MILLIS,
      () -> runOnPage(DshSessionSelection.script(wanted)));
  }

  /**
   * Show the message card.
   * @param text - plain text; newlines become line breaks.
   * @param warning - true when the message reports a failure rather than progress.
   */
  private void showMessage(String text, boolean warning) {
    if (disposed) return;
    String html = StringUtil.escapeXmlEntities(text).replace("\n", "<br>");
    message.setText("<html><div style='text-align:center'>" + html + "</div></html>");
    message.setIcon(warning ? AllIcons.General.Warning : null);
    retry.setVisible(warning);
    cards.show(body, CARD_MESSAGE);
  }

  @Override
  public void dispose() {
    disposed = true;
    JBCefBrowser target = browser;
    browser = null;
    if (target == null) return;
    if (ApplicationManager.getApplication().isDispatchThread()) target.dispose();
    else ApplicationManager.getApplication().invokeLater(target::dispose);
  }
}
