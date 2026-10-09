package dsh.companion;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;

/**
 * Starts the companion when a project opens, and gives that project its own DSH session.
 *
 * This is the project-open hook the platform asks Java plugins to use instead of the removed
 * {@code StartupActivity}; the body has no suspension point, so it returns its value directly and
 * never resumes the continuation.
 */
public final class CompanionProjectActivity implements ProjectActivity {
  private static final Logger LOG = Logger.getInstance(CompanionProjectActivity.class);

  @Override
  public Object execute(Project project, Continuation<? super Unit> continuation) {
    LOG.info("dsh-companion: project opened, starting the bridge");
    CompanionService service = ApplicationManager.getApplication().getService(CompanionService.class);
    service.start();
    if (DshCompanionSettings.getInstance().state().sessionOnProjectOpen) service.syncSession(project, false);
    return Unit.INSTANCE;
  }
}
