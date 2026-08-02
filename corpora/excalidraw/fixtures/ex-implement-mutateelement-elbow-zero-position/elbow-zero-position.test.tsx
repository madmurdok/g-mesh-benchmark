import { pointFrom } from "@excalidraw/math";
import { Excalidraw } from "@excalidraw/excalidraw";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { render } from "@excalidraw/excalidraw/tests/test-utils";
import "@excalidraw/utils/test-utils";

import type { LocalPoint } from "@excalidraw/math";

import type {
  ExcalidrawElbowArrowElement,
  NonDeleted,
} from "../../src/types";

const { h } = window;

/** A standalone (unbound) elbow arrow parked away from the origin. */
const arrowAt = (x: number, y: number) =>
  API.createElement({
    type: "arrow",
    elbowed: true,
    x,
    y,
    width: 90,
    height: 200,
    points: [pointFrom(0, 0), pointFrom(90, 200)],
  }) as NonDeleted<ExcalidrawElbowArrowElement>;

const movedTo = (x: number, y: number) => {
  const arrow = arrowAt(100, 100);
  API.setElements([arrow]);
  h.scene.mutateElement(arrow, {
    x,
    y,
    points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(90, 200)],
  });
  return arrow;
};

describe("moving an elbow arrow onto a zero coordinate", () => {
  beforeEach(async () => {
    localStorage.clear();
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("lands on x: 0 / y: 0 instead of staying at its old position", () => {
    const arrow = movedTo(0, 0);

    expect(arrow.x).toBe(0);
    expect(arrow.y).toBe(0);
  });

  it("ends up where the move asked for, in absolute scene coordinates", () => {
    // Routing an unbound elbow arrow is translation-invariant, so the relative
    // points come out the same wherever it lands — the corruption only shows
    // up once the routed path is placed back into the scene, anchored on a
    // stale position. Nothing throws and no single field looks obviously
    // wrong in isolation; the arrow simply doesn't move.
    const atZero = movedTo(0, 0);
    const atFive = movedTo(5, 5);

    expect(atZero.points).toEqual(atFive.points);

    const globalEnd = (a: NonDeleted<ExcalidrawElbowArrowElement>) => [
      a.x + a.points[a.points.length - 1][0],
      a.y + a.points[a.points.length - 1][1],
    ];
    expect(globalEnd(atZero)).toEqual([90, 200]);
    expect(globalEnd(atFive)).toEqual([95, 205]);
  });

  it("handles a zero on only one axis", () => {
    const zeroX = movedTo(0, 250);
    expect([zeroX.x, zeroX.y]).toEqual([0, 250]);

    const zeroY = movedTo(250, 0);
    expect([zeroY.x, zeroY.y]).toEqual([250, 0]);
  });

  it("still moves an elbow arrow to a non-zero position, as it always did", () => {
    const arrow = movedTo(5, 5);

    expect(arrow.x).toBe(5);
    expect(arrow.y).toBe(5);
    expect(arrow.points).toEqual([
      [0, 0],
      [0, 100],
      [90, 100],
      [90, 200],
    ]);
  });
});
