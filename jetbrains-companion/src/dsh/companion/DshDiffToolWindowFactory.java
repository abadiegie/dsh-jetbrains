package dsh.companion;

import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.components.JBList;
import com.intellij.ui.components.JBScrollPane;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;

import javax.swing.DefaultListModel;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.ListSelectionModel;
import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * The `DSH Changes` tool window: the turns {@code jetbrains-workspace} published, and their diff opened as
 * a native side-by-side IntelliJ diff.
 *
 * The document gives the coordinates; the diff itself comes from DSH, which holds the recorder, through the
 * same signed-cookie API the chat panel authenticates with.
 */
public final class DshDiffToolWindowFactory implements ToolWindowFactory, DumbAware {
  /** Tool window id, which the platform also uses as its display title. */
  public static final String TOOL_WINDOW_ID = "DSH Changes";

  @Override
  public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
    DshDiffPanel panel = new DshDiffPanel(project);
    Content content = ContentFactory.getInstance().createContent(panel, "", false);
    content.setDisposer(panel);
    toolWindow.getContentManager().addContent(content);
  }

  @Override
  public boolean shouldBeAvailable(@NotNull Project project) {
    return !project.isDefault();
  }
}

/** One turn header, or one of its files. */
record DiffRow(DshChanges.Turn turn, DshChanges.ChangedFile file, int index) {
  @Override
  public String toString() {
    if (file == null) return turn.label();
    return "    " + file.display() + "   +" + file.added() + "/-" + file.deleted();
  }
}

/** The list, its status line, and the diff it opens. */
final class DshDiffPanel extends JPanel implements Disposable {
  private final Project project;
  private final DefaultListModel<DiffRow> model = new DefaultListModel<>();
  private final JBList<DiffRow> list = new JBList<>(model);
  private final JLabel status = new JLabel("Reading the review document…");

  DshDiffPanel(Project project) {
    super(new BorderLayout());
    this.project = project;
    JButton refresh = new JButton("Refresh");
    refresh.addActionListener(event -> reload());
    JButton revert = new JButton("Revert file…");
    revert.addActionListener(event -> revertSelected());
    JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
    buttons.add(refresh);
    buttons.add(revert);
    JPanel top = new JPanel(new BorderLayout(8, 0));
    top.add(buttons, BorderLayout.WEST);
    top.add(status, BorderLayout.CENTER);
    add(top, BorderLayout.NORTH);
    list.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
    list.addMouseListener(new MouseAdapter() {
      @Override
      public void mouseClicked(MouseEvent event) {
        if (event.getClickCount() == 2) openSelected();
      }
    });
    add(new JBScrollPane(list), BorderLayout.CENTER);
    reload();
  }

  @Override
  public void dispose() {
    // Nothing outlives the panel: the list, the status line, and the diff tabs belong to the platform.
  }

  /** Read the published document and show it. */
  private void reload() {
    status.setText("Reading the review document…");
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
      Path document = DshChanges.path();
      try {
        List<DshChanges.Turn> turns = DshChanges.read(document);
        ApplicationManager.getApplication().invokeLater(() -> fill(turns, document));
      } catch (IOException failure) {
        ApplicationManager.getApplication().invokeLater(() -> {
          model.clear();
          status.setText(failure.getMessage());
        });
      }
    });
  }

  /**
   * Fill the list from the turns just read.
   *
   * @param turns - the published turns, newest first.
   * @param document - where they came from, named in the status line.
   */
  private void fill(List<DshChanges.Turn> turns, Path document) {
    model.clear();
    int files = 0;
    for (DshChanges.Turn turn : turns) {
      model.addElement(new DiffRow(turn, null, -1));
      for (int index = 0; index < turn.files().size(); index += 1) {
        model.addElement(new DiffRow(turn, turn.files().get(index), index));
        files += 1;
      }
    }
    status.setText(turns.isEmpty()
      ? "No turn has changed a file yet."
      : files + (files == 1 ? " changed file in " : " changed files in ") + turns.size()
        + (turns.size() == 1 ? " turn" : " turns") + " · " + document.getFileName());
  }

  /** Ask DSH for the selected file's diff and open it. */
  private void openSelected() {
    DiffRow row = list.getSelectedValue();
    if (row == null || row.file() == null) {
      status.setText("Double-click a changed file to see its diff.");
      return;
    }
    status.setText("Asking DSH for the diff of " + row.file().display() + "…");
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
      try {
        DshCompanionSettings.State settings = DshCompanionSettings.getInstance().state();
        DshClient client = DshClient.locate(DshSessions.candidateUrls(settings), DshSessions.candidateHomes(settings));
        ChangesDiff diff = client.changesDiff(row.turn().sessionId(), row.turn().seq(), row.index());
        ApplicationManager.getApplication().invokeLater(() -> show(diff, row.turn()));
      } catch (IOException failure) {
        ApplicationManager.getApplication().invokeLater(() ->
          status.setText("Cannot read that diff: " + failure.getMessage()));
      }
    });
  }

  /**
   * Take the selected file's change back. A file the turn created is deleted instead, and a file edited
   * since the turn is refused by {@link ChangesRevert} rather than half-reverted.
   */
  private void revertSelected() {
    DiffRow row = list.getSelectedValue();
    if (row == null || row.file() == null) {
      status.setText("Select a changed file, then revert it.");
      return;
    }
    DshChanges.Turn turn = row.turn();
    String name = row.file().display();
    if (Messages.showYesNoDialog(project, "Take back this turn's change to " + name + "?",
      "DSH Changes", Messages.getQuestionIcon()) != Messages.YES) {
      return;
    }
    status.setText("Reverting " + name + "…");
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
      try {
        DshCompanionSettings.State settings = DshCompanionSettings.getInstance().state();
        DshClient client = DshClient.locate(DshSessions.candidateUrls(settings), DshSessions.candidateHomes(settings));
        ChangesDiff diff = client.changesDiff(turn.sessionId(), turn.seq(), row.index());
        Path file = Path.of(turn.cwd() == null ? "" : turn.cwd(), row.file().path());
        String outcome;
        if (diff.isCreation()) {
          Files.deleteIfExists(file);
          outcome = "Deleted " + name + ", which this turn created.";
        } else {
          String reverted = ChangesRevert.reverted(Files.readString(file, StandardCharsets.UTF_8), diff);
          Files.writeString(file, reverted, StandardCharsets.UTF_8);
          outcome = "Reverted " + name + ".";
        }
        ApplicationManager.getApplication().invokeLater(() -> {
          status.setText(outcome);
          reload();
        });
      } catch (IOException | ChangesRevert.Refused failure) {
        ApplicationManager.getApplication().invokeLater(() -> status.setText(failure.getMessage()));
      }
    });
  }

  /**
   * Show one diff as a native side-by-side comparison.
   *
   * @param diff - the payload DSH served, already split into both texts.
   * @param turn - the turn it belongs to, named in the tab title.
   */
  private void show(ChangesDiff diff, DshChanges.Turn turn) {
    DiffContentFactory factory = DiffContentFactory.getInstance();
    SimpleDiffRequest request = new SimpleDiffRequest(
      diff.title() + "  ·  DSH turn " + turn.turn(),
      factory.create(diff.left()),
      factory.create(diff.right()),
      "before this turn",
      "after this turn");
    DiffManager.getInstance().showDiff(project, request);
    status.setText(diff.hunkCount() + (diff.hunkCount() == 1 ? " hunk" : " hunks") + " · " + diff.title());
  }
}
