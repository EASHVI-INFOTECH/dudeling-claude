import { PEN_COLORS, TOOL_GROUPS, trashIcon, type ToolId } from "./tools";

interface ToolbarProps {
  activeTool: ToolId;
  penColor: string;
  onSelectTool: (tool: ToolId) => void;
  onSelectColor: (color: string) => void;
  onClear: () => void;
}

export function Toolbar({ activeTool, penColor, onSelectTool, onSelectColor, onClear }: ToolbarProps) {
  return (
    <div className="wb-toolbar" role="toolbar" aria-label="Whiteboard tools">
      {TOOL_GROUPS.map((group, i) => (
        <div className="wb-toolbar__group" key={i}>
          {group.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="wb-toolbar__btn"
              aria-pressed={activeTool === tool.id}
              aria-label={tool.label}
              title={`${tool.label} — ${tool.shortcut}`}
              onClick={() => onSelectTool(tool.id)}
            >
              {tool.icon}
            </button>
          ))}
        </div>
      ))}

      <div className="wb-toolbar__group">
        {PEN_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            className="wb-toolbar__swatch"
            style={{ "--swatch": c.value } as React.CSSProperties}
            aria-pressed={penColor === c.value}
            aria-label={`${c.name} ink`}
            title={c.name}
            onClick={() => onSelectColor(c.value)}
          />
        ))}
      </div>

      <div className="wb-toolbar__group">
        <button
          type="button"
          className="wb-toolbar__btn"
          aria-label="Clear board"
          title="Clear board"
          onClick={onClear}
        >
          {trashIcon}
        </button>
      </div>
    </div>
  );
}
