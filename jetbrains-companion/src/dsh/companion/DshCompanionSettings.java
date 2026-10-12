package dsh.companion;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import org.jetbrains.annotations.NotNull;

/** Persisted user choices for the DSH link; defaults need no configuration on a stock machine. */
@State(name = "DshCompanionSettings", storages = @Storage("dsh-companion.xml"))
public final class DshCompanionSettings implements PersistentStateComponent<DshCompanionSettings.State> {
  /** The persisted document. */
  public static final class State {
    /** Create or reuse this project's DSH session when the project opens. */
    public boolean sessionOnProjectOpen = true;
    /** One DSH session for the whole IDE window instead of one per project directory. */
    public boolean windowSession = true;
    /** Explicit DSH base URL; empty discovers the running DSH. */
    public String dshUrl = "";
    /** Explicit DSH home; empty reads the DSH IDE plugin's own setting, then {@code DSH_HOME}, then {@code ~/.dsh}. */
    public String dshHome = "";
    /** Newest published turn this IDE has already mentioned, in epoch milliseconds. */
    public long lastSeenChangesAt;
  }

  private State state = new State();

  /** @return the application-wide settings service. */
  public static DshCompanionSettings getInstance() {
    return ApplicationManager.getApplication().getService(DshCompanionSettings.class);
  }

  @Override
  public State getState() {
    return state;
  }

  @Override
  public void loadState(@NotNull State loaded) {
    state = loaded;
  }

  /** @return the live persisted state. */
  public State state() {
    return state;
  }
}
