import { parseLibraryJSON } from "../../data/blob";
import { mergeLibraryItems } from "../../data/library";

import { API } from "../helpers/api";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { LibraryItem, LibraryItems } from "../../types";

const libraryItem = (id: string, elements: ExcalidrawElement[]): LibraryItem => ({
  id,
  status: "unpublished",
  elements: elements as LibraryItem["elements"],
  created: 0,
});

/**
 * What an import does to an item that is already in the local library: the
 * shapes are byte-for-byte the same drawing, but every identity field the
 * pipeline regenerates has moved on.
 */
const reimported = (item: LibraryItem, suffix: string): LibraryItem => ({
  ...item,
  id: `${item.id}-${suffix}`,
  created: item.created + 1000,
  elements: item.elements.map((element, idx) => ({
    ...element,
    id: `${element.id}-${suffix}-${idx}`,
    versionNonce: element.versionNonce + 1,
  })) as LibraryItem["elements"],
});

describe("mergeLibraryItems: importing a library that is already there", () => {
  it("does not duplicate the library shipped in this repo's own fixtures", async () => {
    const json = (await API.readFile(
      "./fixtures/fixture_library.excalidrawlib",
      "utf8",
    )) as string;

    // Two independent imports of the exact same file — precisely what a user
    // does when they click "Add to Excalidraw" on the same library twice.
    const local: LibraryItems = parseLibraryJSON(json);
    const incoming: LibraryItems = parseLibraryJSON(json);

    expect(mergeLibraryItems(local, incoming)).toHaveLength(local.length);
  });

  it("recognises an item whose elements were re-identified along the way", () => {
    const local = libraryItem("local", [
      API.createElement({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 }),
      API.createElement({ id: "b", type: "ellipse", x: 120, y: 40, width: 60, height: 60 }),
    ]);

    expect(mergeLibraryItems([local], [reimported(local, "again")])).toEqual([local]);
  });

  it("de-duplicates every repeat, not just the first", () => {
    const local = libraryItem("local", [
      API.createElement({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 }),
    ]);

    const merged = mergeLibraryItems(
      [local],
      [reimported(local, "one"), reimported(local, "two")],
    );

    expect(merged).toHaveLength(1);
  });

  it("still adds an item that actually looks different", () => {
    const local = libraryItem("local", [
      API.createElement({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 }),
    ]);
    const bigger = libraryItem("bigger", [
      API.createElement({ id: "c", type: "rectangle", x: 0, y: 0, width: 100, height: 250 }),
    ]);
    const otherType = libraryItem("other-type", [
      API.createElement({ id: "d", type: "ellipse", x: 0, y: 0, width: 100, height: 100 }),
    ]);

    expect(mergeLibraryItems([local], [bigger, otherType])).toHaveLength(3);
  });

  it("still treats a different element count and a different z-order as different items", () => {
    const rect = API.createElement({
      id: "a",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    const ellipse = API.createElement({
      id: "b",
      type: "ellipse",
      x: 120,
      y: 40,
      width: 60,
      height: 60,
    });

    const local = libraryItem("local", [rect, ellipse]);
    const fewerElements = libraryItem("fewer", [rect]);
    const restacked = libraryItem("restacked", [ellipse, rect]);

    expect(mergeLibraryItems([local], [fewerElements, restacked])).toHaveLength(3);
  });
});
