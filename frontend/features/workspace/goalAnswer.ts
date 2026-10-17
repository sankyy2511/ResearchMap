/**
 * The answer to "Do you have a goal for today?", kept in the browser until tracking starts.
 * null = not answered yet, "" = no goal, any other text = the goal.
 */
const key = (workspaceId: string) => `goal-answer:${workspaceId}`;

export function getGoalAnswer(workspaceId: string): string | null {
  try {
    return localStorage.getItem(key(workspaceId));
  } catch {
    return null;
  }
}

export function saveGoalAnswer(workspaceId: string, goal: string) {
  try {
    localStorage.setItem(key(workspaceId), goal);
  } catch {
    /* storage is blocked: the question is asked again when tracking starts */
  }
}

export function clearGoalAnswer(workspaceId: string) {
  try {
    localStorage.removeItem(key(workspaceId));
  } catch {
    /* nothing to clear */
  }
}
