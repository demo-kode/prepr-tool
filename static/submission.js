'use strict';
const submission = (() => {
  const panel = document.querySelector('#submission');
  const bar = panel.querySelector('progress');
  const summary = panel.querySelector('.submission-summary');
  const rows = panel.querySelector('ul');
  const note = panel.querySelector('.submission-note');
  const result = panel.querySelector('.submission-result');
  const dismiss = panel.querySelector('button');
  const statuses = {waiting:'Waiting', checking:'Running checks', checked:'Checks passed', pushing:'Pushing branch', pushed:'Branch pushed',
    creating:'Opening PR', opened:'PR opened'};
  let reviewId, dismissed, signature, pending = false;

  dismiss.onclick = () => panel.close();
  panel.addEventListener('close', () => { dismissed = reviewId; });

  function show() {
    dismissed = null;
    if (!panel.open) panel.showModal();
  }

  function render(review, decision, warning = '') {
    const terminal = ['shipped','blocked'].includes(decision.status);
    const progress = decision.progress || {};
    const entries = Object.entries(progress.repos || Object.fromEntries(review.repos.map(r => [r.name,'waiting'])));
    const key = JSON.stringify([review.id,decision,warning]);
    if (signature === key) return;
    signature = key;
    panel.querySelector('.submission-review').textContent = review.title;
    const claimed = ['preparing','blocked'].includes(decision.status) || progress.verified;
    const complete = decision.status === 'shipped';
    const confirmed = entries.filter(([,stage]) => stage === 'opened').length;
    const messages = {sending:'Sending your request…', requested:'Waiting for the runner',
      preparing:progress.verified ? 'Snapshot verified' : 'Verifying the approved snapshot',
      shipped:'Submission complete', blocked:'Submission blocked', error:'Could not submit request'};
    if (decision.status === 'preparing' && entries.some(([,stage]) => stage !== 'waiting')) {
      messages.preparing = confirmed === entries.length ? 'Recording the PR links' :
        entries.every(([,s]) => ['waiting','checking','checked'].includes(s)) ? 'Checking repositories' : 'Publishing pull requests';
    }
    summary.textContent = messages[decision.status];
    note.textContent = warning;
    bar.max = 3 + entries.length * 3;
    bar.value = complete ? bar.max : Number(!!claimed) + Number(!!progress.verified) +
      entries.reduce((n,[,s]) => n + Number(!['waiting','checking'].includes(s)) + Number(['pushed','creating','opened'].includes(s)) + Number(s === 'opened'),0);
    panel.dataset.status = decision.status;
    const opened = complete ? entries.length : confirmed;
    panel.querySelector('.submission-count').textContent = opened + ' / ' + entries.length + ' PRs';
    rows.replaceChildren(...entries.map(([name,stage]) => {
      const row = el('li');
      row.dataset.stage = complete ? 'opened' : stage;
      row.append(el('span','submission-name',name),el('span','submission-stage',statuses[row.dataset.stage]));
      return row;
    }));
    dismiss.textContent = terminal || decision.status === 'error' ? 'Done' : 'Hide progress';
    result.replaceChildren();
    if (decision.result) {
      for (const part of decision.result.split(/(https?:\/\/[^\s<>]+)/g)) {
        if (!/^https?:\/\//.test(part)) result.append(document.createTextNode(part));
        else {
          const link = el('a','',part);
          link.href = part; link.target = '_blank'; link.rel = 'noopener noreferrer';
          result.append(link);
        }
      }
    }
  }

  function update(review, watch) {
    const decision = watch.decision;
    if (pending || decision?.action !== 'ship') return;
    const issue = watch.watcher?.error || (watch.start?.status === 'failed' ? watch.start.error :
      watch.start?.status === 'unanswered' ? 'The runner has not answered. Hide progress to start it again.' : '');
    reviewId = review.id;
    const active = ['requested','preparing'].includes(decision.status);
    render(review, decision, active ? issue : '');
    if (active && dismissed !== reviewId && !panel.open) show();
  }

  async function request(review) {
    if (pending) return;
    pending = true; reviewId = review.id;
    render(review, {status:'sending'});
    show();
    try {
      const decision = await api('/api/reviews/'+review.id+'/decision',{action:'ship',snapshot:review.snapshot});
      review.decision = decision;
      render(review, decision);
    } catch (error) {
      render(review, {status:'error'}, error.message);
      throw error;
    } finally { pending = false; }
  }

  function offline() {
    if (panel.open && !pending) {
      signature = null;
      note.textContent = 'Live status unavailable. Reconnecting…';
    }
  }
  return {request, update, show, offline};
})();
