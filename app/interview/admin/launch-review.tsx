"use client";
import {useEffect,useState} from 'react';
type Review={reviewed_at:string;candidate_count:number;eligible_count:number;suppressed_count:number;state:string;production_url:string;gmail_message_ids:string[];release_gates:{blockers:string[]}};
export default function InterviewLaunchReview(){const[review,setReview]=useState<Review|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;void fetch('/api/interview/admin/launch-review',{cache:'no-store'}).then(async response=>{const data=await response.json();if(!response.ok||!data.ok)throw Error();if(active)setReview(data.review);}).catch(()=>{if(active)setError('Launch review could not be loaded.');});return()=>{active=false;};},[]);
 return <section className="my-6 rounded-2xl border border-amber-300 bg-amber-50 p-5"><h2 className="text-xl font-bold">October 29 one-time invitation review</h2>
 {error?<p role="alert">{error}</p>:!review?<p>No launch review recorded.</p>:<><p className="mt-2">Reviewed {new Date(review.reviewed_at).toLocaleString()} · {review.state}</p><p className="mt-2 font-semibold">{review.candidate_count} pipeline candidates · {review.eligible_count} pass recipient review · {review.suppressed_count} suppressed · {review.gmail_message_ids.length} real messages sent</p><p className="mt-2">Production booking: <a className="underline" href={review.production_url}>{review.production_url}</a></p><ul className="mt-3 list-disc pl-5">{review.release_gates.blockers.map(reason=><li key={reason}>{reason}</li>)}</ul><p className="mt-3 text-sm">This is a dry run. No invitations or booking tokens were sent. Recheck recipient eligibility and send limits immediately before any authorized production run. Normal Friday/Sunday/Monday processing is unchanged.</p></>}
 </section>;
}
