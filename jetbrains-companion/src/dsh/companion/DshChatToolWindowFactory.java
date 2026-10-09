package dsh.companion;

import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;

/**
 * Creates the `DSH Chat` tool window: one embedded DSH web client per project.
 *
 * The tool window is available in every project — it needs no DSH-side plugin and reports its own
 * connection state — so it appears before DSH is running and recovers with its Retry action.
 */
public final class DshChatToolWindowFactory implements ToolWindowFactory, DumbAware {
  /** Tool window id, which the platform also uses as its display title. */
  public static final String TOOL_WINDOW_ID = "DSH Chat";

  @Override
  public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
    DshChatPanel panel = new DshChatPanel(project);
    Content content = ContentFactory.getInstance().createContent(panel, "", false);
    content.setDisposer(panel);
    toolWindow.getContentManager().addContent(content);
  }

  @Override
  public boolean shouldBeAvailable(@NotNull Project project) {
    return !project.isDefault();
  }
}
