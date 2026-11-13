import { useEffect, useRef } from 'react';
import type { Skill } from './api';

// The slash command being typed: the draft starts with "/" and the cursor is still inside that
// first word. Claude Code only runs a skill named at the very start of a prompt.
export function slashQuery(text: string, cursor: number): string | null {
  const m = text.match(/^\/([^\s/]*)/);
  if (!m || cursor > m[0].length) return null;
  return m[1].toLowerCase();
}

// Name prefix first, then name contains, then description contains.
export function matchSkills(skills: Skill[], query: string): Skill[] {
  if (!query) return skills;
  const rank = (s: Skill) => {
    const name = s.name.toLowerCase();
    if (name.startsWith(query)) return 0;
    if (name.includes(query)) return 1;
    if (s.description.toLowerCase().includes(query)) return 2;
    return -1;
  };
  return skills
    .map((s) => ({ s, r: rank(s) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s);
}

export function SkillMenu({
  items,
  active,
  onHover,
  onPick,
}: {
  items: Skill[];
  active: number;
  onHover: (i: number) => void;
  onPick: (skill: Skill) => void;
}) {
  const list = useRef<HTMLUListElement>(null);

  // Keep the highlighted row in view while moving with the arrow keys.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="skill-menu" role="listbox" aria-label="Skills">
      <div className="skill-menu-head">Skills</div>
      {items.length === 0 ? (
        <div className="skill-empty">No matching skills in this folder or its parents.</div>
      ) : (
        <ul ref={list}>
          {items.map((s, i) => (
            <li
              key={s.name}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              title={`${s.description}\n\n${s.path}`}
              onMouseEnter={() => onHover(i)}
              // mousedown, not click: keeps focus in the text box.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s);
              }}
            >
              <svg className="skill-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8L8 1.5Zm0 0v6.6m0 0 6-3.3M8 8.1 2 4.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <div className="skill-text">
                <div className="skill-name">/{s.name}</div>
                <div className="skill-desc">{s.description || 'No description.'}</div>
              </div>
              <span className="skill-source">{s.source}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
