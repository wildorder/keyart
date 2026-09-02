/** A single visual-direction summary card (name + summary + a few rules). */
import React from "react";
import type { DirectionContent } from "../types";

export function DirectionCard({
  direction,
  isApproved,
}: {
  direction: DirectionContent;
  isApproved?: boolean;
}) {
  return (
    <div className={`direction-card ${isApproved ? "approved" : ""}`}>
      <h3>
        {direction.name} {isApproved && "✓"}
      </h3>
      <p>{direction.summary}</p>
      {direction.usage?.rules?.length ? (
        <ul className="rules-list">
          {direction.usage.rules.slice(0, 3).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
