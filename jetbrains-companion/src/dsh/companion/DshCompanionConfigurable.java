package dsh.companion;

import com.intellij.openapi.options.Configurable;
import com.intellij.ui.components.JBTextField;
import com.intellij.util.ui.FormBuilder;
import java.awt.BorderLayout;
import javax.swing.JCheckBox;
import javax.swing.JComponent;
import javax.swing.JPanel;
import org.jetbrains.annotations.Nullable;

/** Settings page for the DSH link: the session scope toggles and explicit DSH address overrides. */
public final class DshCompanionConfigurable implements Configurable {
  private JCheckBox sessionOnOpen;
  private JCheckBox windowSession;
  private JBTextField dshUrl;
  private JBTextField dshHome;

  @Override
  public String getDisplayName() {
    return "DSH Companion";
  }

  @Nullable
  @Override
  public JComponent createComponent() {
    sessionOnOpen = new JCheckBox("Create or reuse this project's DSH session when it opens");
    windowSession = new JCheckBox("One DSH session for the whole IDE window (at the shared parent of its projects)");
    dshUrl = new JBTextField();
    dshHome = new JBTextField();
    JPanel form = FormBuilder.createFormBuilder()
      .addComponent(sessionOnOpen)
      .addComponent(windowSession)
      .addLabeledComponent("DSH URL (empty discovers the running DSH):", dshUrl)
      .addLabeledComponent("DSH home (empty reads the DeepSeek Harness plugin setting, $DSH_HOME, then ~/.dsh):", dshHome)
      .addComponentFillVertically(new JPanel(), 0)
      .getPanel();
    JPanel wrapper = new JPanel(new BorderLayout());
    wrapper.add(form, BorderLayout.NORTH);
    return wrapper;
  }

  @Override
  public boolean isModified() {
    DshCompanionSettings.State state = DshCompanionSettings.getInstance().state();
    return sessionOnOpen.isSelected() != state.sessionOnProjectOpen
      || windowSession.isSelected() != state.windowSession
      || !dshUrl.getText().strip().equals(state.dshUrl)
      || !dshHome.getText().strip().equals(state.dshHome);
  }

  @Override
  public void apply() {
    DshCompanionSettings.State state = DshCompanionSettings.getInstance().state();
    state.sessionOnProjectOpen = sessionOnOpen.isSelected();
    state.windowSession = windowSession.isSelected();
    state.dshUrl = dshUrl.getText().strip();
    state.dshHome = dshHome.getText().strip();
  }

  @Override
  public void reset() {
    DshCompanionSettings.State state = DshCompanionSettings.getInstance().state();
    sessionOnOpen.setSelected(state.sessionOnProjectOpen);
    windowSession.setSelected(state.windowSession);
    dshUrl.setText(state.dshUrl);
    dshHome.setText(state.dshHome);
  }
}
