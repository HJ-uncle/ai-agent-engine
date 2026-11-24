/** Applies equally to an access token, a rotated token, refresh retry and a long-lived socket.
 * s is the candidate session; the single parameter is the absolute current time in milliseconds.
 * Only the parent's session lifetime (not its rotating access token) constrains delegation. */
export const familySessionAllowed = `NOT EXISTS (
  SELECT 1 FROM account_children f WHERE f.child_id=s.user_id AND f.disabled_at IS NOT NULL
) AND NOT EXISTS (
  SELECT 1 FROM account_child_sessions d LEFT JOIN account_sessions parent ON parent.id=d.parent_session_id
  LEFT JOIN account_children f ON f.child_id=s.user_id AND f.parent_id=parent.user_id
  WHERE d.session_id=s.id AND (parent.id IS NULL OR parent.revoked_at IS NOT NULL OR parent.expires_at<=? OR f.child_id IS NULL)
)`
