/** Local draft checkboxes only. The founder must still review and approve the
 * exact recipient manifest, and the server independently rechecks eligibility.
 * Never auto-apply to unselected or non-frequency-limited applicants.
 */
export type FounderFollowUpCandidate={
  campus:"BU"|"BC";
  pageId:string;
  frequencyLimited?:boolean;
};
export function applySelectedFounderExceptions(
  candidates:readonly FounderFollowUpCandidate[],
  selected:ReadonlySet<string>,
  existing:ReadonlySet<string>,
):Set<string>{
  const next=new Set(existing);
  for(const candidate of candidates){
    if(!candidate.frequencyLimited)continue;
    const key=candidate.campus+":"+candidate.pageId;
    if(selected.has(key))next.add(key);
  }
  return next;
}
