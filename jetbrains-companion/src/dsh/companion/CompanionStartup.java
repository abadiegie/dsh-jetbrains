package dsh.companion;

import com.intellij.ide.AppLifecycleListener;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Starts the companion once the application has started, which is earlier than any project opens and
 * also covers a window that only shows the welcome screen. The service owns its own disposal.
 */
public final class CompanionStartup implements AppLifecycleListener {
  private static final Logger LOG = Logger.getInstance(CompanionStartup.class);

  @Override
  public void appStarted() {
    LOG.info("dsh-companion: application started");
    ApplicationManager.getApplication().getService(CompanionService.class).start();
  }
}
