import { Excalidraw } from "@excalidraw/excalidraw";
import { actionToggleLinearEditor } from "@excalidraw/excalidraw/actions/actionLinearEditor";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Pointer } from "@excalidraw/excalidraw/tests/helpers/ui";
import { act, render } from "@excalidraw/excalidraw/tests/test-utils";
import { pointFrom } from "@excalidraw/math";

import type { NonDeletedExcalidrawElement } from "../../src/types";

const { h } = window;
const mouse = new Pointer("mouse");

/**
 * A labelled arrow, with the caller deciding whether the bound label sits
 * before or after its container in the scene's element order. Both orders are
 * reachable in a real document — z-order is just array order, and duplicating
 * or importing elements can leave a label ahead of the shape it belongs to.
 */
const labelledArrow = (labelFirst: boolean) => {
  const arrow = API.createElement({
    type: "arrow",
    id: "arrow1",
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    points: [pointFrom(0, 0), pointFrom(100, 0)],
    boundElements: [{ type: "text", id: "text1" }],
  });
  const label = API.createElement({
    type: "text",
    id: "text1",
    x: 30,
    y: -10,
    width: 40,
    height: 20,
    containerId: "arrow1",
  });

  API.setElements(
    (labelFirst ? [label, arrow] : [arrow, label]) as NonDeletedExcalidrawElement[],
  );
  // Select it the way a user does, so the app builds its own linear-editor
  // state rather than the test handing it a pre-baked one.
  mouse.clickAt(50, 0);

  return arrow;
};

const toggleLineEditor = () =>
  act(() => {
    h.app.actionManager.executeAction(actionToggleLinearEditor);
  });

describe("toggling the line editor on a labelled arrow", () => {
  beforeEach(async () => {
    localStorage.clear();
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("works when the label comes after the arrow", () => {
    const arrow = labelledArrow(false);
    expect(h.state.selectedLinearElement?.elementId).toBe(arrow.id);

    expect(toggleLineEditor).not.toThrow();
    expect(h.state.selectedLinearElement?.isEditing).toBe(true);
    expect(h.state.selectedLinearElement?.elementId).toBe(arrow.id);
  });

  it("works just the same when the label comes before the arrow", () => {
    const arrow = labelledArrow(true);
    // Same selection either way: the label is never selected on its own.
    expect(h.state.selectedLinearElement?.elementId).toBe(arrow.id);
    expect(Object.keys(h.state.selectedElementIds)).toEqual([arrow.id]);

    expect(toggleLineEditor).not.toThrow();
    expect(h.state.selectedLinearElement?.isEditing).toBe(true);
    expect(h.state.selectedLinearElement?.elementId).toBe(arrow.id);
  });

  it("toggles back off again, whichever order the label is in", () => {
    labelledArrow(true);

    toggleLineEditor();
    expect(h.state.selectedLinearElement?.isEditing).toBe(true);

    toggleLineEditor();
    expect(h.state.selectedLinearElement?.isEditing).toBe(false);
  });
});
