import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowCounterClockwise, CaretUpDown, GearSix, Keyboard, Moon, PencilSimple, SidebarSimple, SquaresFour, Sun } from '@phosphor-icons/react';
import { activeEpisodeId, episode, timecode } from '@/data/episode';
import { isSample } from '@/features/samples/seed';
import { cx } from '@/lib/cx';
import { useProject } from '@/store/project';
import { useTheme } from '@/store/theme';
import { Kbd, LogoMark, Menu, Tooltip } from '@/ui';
import { SECTION_GROUPS, SECTIONS, sectionPath } from './sections';
import type { SectionDef, SectionId } from './sections';
import { useShell } from './store';

/**
 * The project sidebar: a 232 px floating surface with the
 * logo, the project switcher, two quiet groups (Build, Publish) and theme / shortcuts / settings at
 * the bottom. No status glyphs: every section is always reachable. `collapsed` renders the 64 px
 * icon rail with tooltips.
 */
export function SidebarContent({ projectId, current, collapsed, onNavigate }: { projectId: string; current: SectionId | null; collapsed: boolean; onNavigate?: () => void }) {
  const toggleCollapsed = useShell((s) => s.toggleCollapsed);
  const setShell = useShell((s) => s.set);
  const resolved = useTheme((s) => s.resolved);
  const setMode = useTheme((s) => s.setMode);

  return (
    <div className="flex h-full flex-col">
      {/* Logo row */}
      <div className={cx('flex h-12 shrink-0 items-center gap-2 px-3', collapsed && 'justify-center px-0')}>
        <Link to="/" onClick={onNavigate} aria-label="Cameo, all projects" className={cx('flex items-center gap-2 rounded-[8px] text-14 font-semibold tracking-[-0.01em] text-text', !collapsed && 'px-1')}>
          <LogoMark size={20} title={null} />
          {!collapsed && 'Cameo'}
        </Link>
        {!collapsed && (
          <Tooltip content="Collapse sidebar" shortcut="[" side="bottom">
            <button type="button" onClick={toggleCollapsed} aria-label="Collapse sidebar" className={iconBtn('ml-auto max-md:hidden')}>
              <SidebarSimple size={18} />
            </button>
          </Tooltip>
        )}
      </div>

      <div className={cx('px-2 pb-1', collapsed && 'flex justify-center px-0')}>
        <ProjectSwitcher collapsed={collapsed} onNavigate={onNavigate} />
      </div>

      <nav aria-label="Project" className={cx('no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-3', collapsed && 'items-center px-0')}>
        {SECTION_GROUPS.map((group, gi) => (
          <div key={group} role="group" aria-label={group} className={cx('flex w-full flex-col gap-0.5', gi > 0 && 'mt-5', collapsed && 'items-center')}>
            {collapsed ? (
              gi > 0 && <span aria-hidden className="mb-2 -mt-2 h-px w-6 bg-border" />
            ) : (
              <p className="px-2.5 pb-1 text-12 font-medium text-text-3">{group}</p>
            )}
            {SECTIONS.filter((s) => s.group === group).map((s) => (
              <NavItem key={s.id} section={s} projectId={projectId} current={current === s.id} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>

      <div className={cx('flex shrink-0 flex-col gap-0.5 px-2 pt-2 pb-2', collapsed && 'items-center px-0')}>
        <FootItem
          collapsed={collapsed}
          icon={resolved === 'dark' ? <Sun /> : <Moon />}
          label={resolved === 'dark' ? 'Light theme' : 'Dark theme'}
          hint="T"
          onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
        />
        <FootItem collapsed={collapsed} icon={<Keyboard />} label="Shortcuts" hint="?" onClick={() => (onNavigate?.(), setShell({ shortcuts: true }))} />
        <FootItem collapsed={collapsed} icon={<GearSix />} label="Settings" onClick={() => (onNavigate?.(), setShell({ settings: true }))} />
        {collapsed && (
          <Tooltip content="Expand sidebar" shortcut="[" side="right">
            <button type="button" onClick={toggleCollapsed} aria-label="Expand sidebar" className={iconBtn('mt-1')}>
              <SidebarSimple size={18} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

const iconBtn = (extra?: string) =>
  cx('inline-flex size-8 items-center justify-center rounded-[8px] text-text-3 transition-colors duration-200 ease-cameo hover:bg-surface-2 hover:text-text max-md:size-11', extra);

/** Poster 28, name, duration. Menu: All projects, Rename, Start over or Restore sample (confirmed in ShellOverlays). */
function ProjectSwitcher({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const setShell = useShell((s) => s.set);
  const name = useProject((s) => s.name);
  const poster = <img src={episode.poster} alt="" className="size-7 shrink-0 rounded-[8px] object-cover object-[50%_30%] shadow-[0_0_0_1px_var(--border)]" />;
  return (
    <Menu
      label="Project"
      align="start"
      items={[
        { id: 'all', label: 'All projects', icon: <SquaresFour />, onSelect: () => (onNavigate?.(), navigate('/')) },
        { id: 'rename', label: 'Rename…', icon: <PencilSimple />, onSelect: () => (onNavigate?.(), setShell({ rename: true })) },
        'divider',
        { id: 'reset', label: isSample(activeEpisodeId) ? 'Restore sample…' : 'Start over…', icon: <ArrowCounterClockwise />, onSelect: () => (onNavigate?.(), setShell({ confirmReset: true })) },
      ]}
      trigger={(props) =>
        collapsed ? (
          <Tooltip content={name} side="right" delay={150}>
            <button type="button" {...props} aria-label={`Project: ${name}. Project menu`} className="inline-flex size-10 items-center justify-center rounded-[10px] transition-colors duration-200 ease-cameo hover:bg-surface-2">
              {poster}
            </button>
          </Tooltip>
        ) : (
          <button
            type="button"
            {...props}
            aria-label={`Project: ${name}. Project menu`}
            className="flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2 text-left transition-colors duration-200 ease-cameo hover:bg-surface-2"
          >
            {poster}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-14 font-medium text-text">{name}</span>
              <span className="mono block truncate text-12 text-text-3">{timecode(Math.round(episode.duration))}</span>
            </span>
            <CaretUpDown size={14} className="shrink-0 text-text-3" aria-hidden />
          </button>
        )
      }
    />
  );
}

function NavItem({ section: s, projectId, current, collapsed, onNavigate }: { section: SectionDef; projectId: string; current: boolean; collapsed: boolean; onNavigate?: () => void }) {
  const Icon = s.icon;
  const el = (
    <Link
      to={sectionPath(projectId, s.id)}
      onClick={onNavigate}
      aria-current={current ? 'page' : undefined}
      aria-label={collapsed ? s.label : undefined}
      className={cx(
        'group relative flex shrink-0 items-center rounded-[10px] text-14 transition-[background-color,color] duration-200 ease-cameo',
        collapsed ? 'size-[40px] justify-center' : 'h-[36px] w-full gap-2.5 pr-2 pl-2.5 max-md:h-11',
        current ? 'bg-surface-3 font-medium text-text' : 'text-text-2 hover:bg-surface-2 hover:text-text',
      )}
    >
      {current && <span aria-hidden className={cx('absolute w-[2px] rounded-full bg-accent', collapsed ? 'top-2.5 bottom-2.5 left-0' : 'top-2 bottom-2 left-0')} />}
      <Icon size={18} weight={current ? 'fill' : 'regular'} aria-hidden className={cx('shrink-0', current ? 'text-text' : 'text-text-3 group-hover:text-text-2')} />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{s.label}</span>}
    </Link>
  );
  return (
    <Tooltip content={s.label} shortcut={`G ${s.key.toUpperCase()}`} side="right" delay={collapsed ? 150 : 600} className={collapsed ? undefined : 'w-full'}>
      {el}
    </Tooltip>
  );
}

const FootItem = forwardRef<HTMLButtonElement, { collapsed: boolean; icon: ReactNode; label: string; hint?: string; onClick: () => void }>(function FootItem(
  { collapsed, icon, label, hint, onClick },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      className={cx(
        'group flex shrink-0 items-center rounded-[10px] text-14 text-text-2 transition-[background-color,color] duration-200 ease-cameo hover:bg-surface-2 hover:text-text [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-text-3 hover:[&_svg]:text-text-2',
        collapsed ? 'size-[40px] justify-center' : 'h-[36px] w-full gap-2.5 pr-2 pl-2.5 max-md:h-11',
      )}
    >
      {icon}
      {!collapsed && <span className="flex-1 text-left">{label}</span>}
      {!collapsed && hint && <Kbd className="h-5 min-w-5 px-1 text-11 opacity-0 transition-opacity duration-200 group-hover:opacity-100 max-md:hidden">{hint}</Kbd>}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} shortcut={hint} side="right" delay={150}>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
});
