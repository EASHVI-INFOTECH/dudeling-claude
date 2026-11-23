import type { ReactNode } from "react";

/** The Excalidraw tools Dudeling exposes. Everything else stays hidden. */
export type ToolId =
  | "selection"
  | "hand"
  | "pen"
  | "highlighter"
  | "eraser"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "text";

export type ExcalidrawToolType =
  | "selection"
  | "hand"
  | "freedraw"
  | "eraser"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "text";

export interface ToolDef {
  id: ToolId;
  label: string;
  shortcut: string;
  excalidraw: ExcalidrawToolType;
  icon: ReactNode;
}

const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const TOOL_GROUPS: ToolDef[][] = [
  [
    {
      id: "selection",
      label: "Select",
      shortcut: "V",
      excalidraw: "selection",
      icon: svg(
        <path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z" />,
      ),
    },
    {
      id: "hand",
      label: "Hand (pan)",
      shortcut: "H",
      excalidraw: "hand",
      icon: svg(
        <>
          <path d="M18 11V6a2 2 0 0 0-4 0" />
          <path d="M14 10V4a2 2 0 0 0-4 0v2" />
          <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </>,
      ),
    },
  ],
  [
    {
      id: "pen",
      label: "Pen",
      shortcut: "P",
      excalidraw: "freedraw",
      icon: svg(
        <>
          <path d="M21.17 6.81a1 1 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.36a.5.5 0 0 0 .62.62l4.36-1.32a2 2 0 0 0 .83-.5z" />
          <path d="m15 5 4 4" />
        </>,
      ),
    },
    {
      id: "highlighter",
      label: "Highlighter",
      shortcut: "M",
      excalidraw: "freedraw",
      icon: svg(
        <>
          <path d="m9 11-6 6v3h9l3-3" />
          <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
        </>,
      ),
    },
    {
      id: "eraser",
      label: "Eraser",
      shortcut: "E",
      excalidraw: "eraser",
      icon: svg(
        <>
          <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
          <path d="M22 21H7" />
          <path d="m5 11 9 9" />
        </>,
      ),
    },
  ],
  [
    {
      id: "rectangle",
      label: "Rectangle",
      shortcut: "R",
      excalidraw: "rectangle",
      icon: svg(<rect width="18" height="18" x="3" y="3" rx="2" />),
    },
    {
      id: "ellipse",
      label: "Ellipse",
      shortcut: "O",
      excalidraw: "ellipse",
      icon: svg(<circle cx="12" cy="12" r="9" />),
    },
    {
      id: "arrow",
      label: "Arrow",
      shortcut: "A",
      excalidraw: "arrow",
      icon: svg(
        <>
          <path d="M5 19 19 5" />
          <path d="M9 5h10v10" />
        </>,
      ),
    },
    {
      id: "text",
      label: "Text",
      shortcut: "T",
      excalidraw: "text",
      icon: svg(
        <>
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
        </>,
      ),
    },
  ],
];

export const ALL_TOOLS = TOOL_GROUPS.flat();

export const PEN_COLORS = [
  { name: "Ink", value: "#1e1e1e" }, // Excalidraw inverts this to light ink in dark mode
  { name: "Red", value: "#e03131" },
  { name: "Blue", value: "#1971c2" },
  { name: "Green", value: "#2f9e44" },
  { name: "Orange", value: "#f08c00" },
];

export const HIGHLIGHTER = { color: "#fcc419", strokeWidth: 4, opacity: 40 };
export const PEN = { strokeWidth: 2, opacity: 100 };

export const trashIcon = svg(
  <>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </>,
);
