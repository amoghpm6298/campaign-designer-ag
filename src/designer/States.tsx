// The four states every surface owes, in one place.
//
// PORTED from agent360, where `LoadError`, `LazyBoundary` and the
// empty-state recipe are shared by every page — which is most of why its
// screens feel like one product rather than a set of pages that each
// invented their own blank.
//
// This app had three different blanks: a dashed card on the designer, a
// `.cd-empty-panel` on Chats, and a bare centred sentence elsewhere. Three
// recipes drift, and the drift shows up as "some screens look finished and
// some do not" long before anyone can name which.
import { Component, type ReactNode } from 'react';
import { RotateCw, WifiOff } from 'lucide-react';

/**
 * Nothing here yet.
 *
 * DASHED MEANS "not yet", everywhere in this product — the empty journey,
 * the empty chat list, a path with no messages on it. A solid border would
 * say the box is the content.
 *
 * The sentence is required, and it must say what will appear AND how to
 * make it appear. "No chats yet" on its own leaves someone looking at a
 * blank screen they do not know how to fill.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cd-blank">
      {icon && <span className="cd-blank-chip">{icon}</span>}
      <h3 className="cd-blank-h">{title}</h3>
      <p className="cd-blank-p">{children}</p>
      {action}
    </div>
  );
}

/**
 * Something that should have loaded did not.
 *
 * DISTINCT FROM EMPTY, and the distinction is the point: an empty list and
 * a list that failed to load look identical if you only render "nothing
 * here", and the second one has a Retry that the first must not offer.
 */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="cd-loaderr" role="alert">
      <span className="cd-blank-chip">
        <WifiOff size={18} />
      </span>
      <p className="cd-blank-p">{message}</p>
      {onRetry && (
        <button className="cd-btn" onClick={onRetry}>
          <RotateCw size={13} /> Retry
        </button>
      )}
    </div>
  );
}

/**
 * A placeholder with the GEOMETRY of what is coming, so nothing jumps when
 * the real thing arrives. A spinner is the right answer when the shape is
 * not predictable; these rows are.
 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="cd-skel" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="cd-skel-row" key={i}>
          <span className="cd-skel-bar w1" />
          <span className="cd-skel-bar w2" />
        </div>
      ))}
    </div>
  );
}

/**
 * One pane failing must not take the application with it.
 *
 * AND THE TWO CAUSES ARE DIFFERENT ADVICE, which is the whole reason this
 * is not a single "something went wrong": a chunk that failed to load
 * because a deploy replaced it is fixed by reloading, and a bug is not —
 * Reload would hit it again, so that case gets Retry instead.
 *
 * `label` names the pane in the copy ("the canvas", "the journey"), because
 * "something went wrong" with no subject tells the reader nothing about
 * what they have lost.
 */
export class PaneBoundary extends Component<
  { label: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A chunk that will not load is a stale build, not a bug in this code.
    const stale = /chunk|dynamically imported module|Importing a module script failed/i.test(error.message);
    return (
      <div className="cd-boundary" role="alert">
        <p className="cd-blank-h">
          {stale ? `Could not load ${this.props.label}.` : `Something went wrong in ${this.props.label}.`}
        </p>
        <p className="cd-blank-p">{stale ? 'The app may have been updated.' : error.message}</p>
        {stale ? (
          <button className="cd-btn" onClick={() => window.location.reload()}>
            <RotateCw size={13} /> Reload
          </button>
        ) : (
          <button className="cd-btn" onClick={() => this.setState({ error: null })}>
            <RotateCw size={13} /> Retry
          </button>
        )}
      </div>
    );
  }
}
