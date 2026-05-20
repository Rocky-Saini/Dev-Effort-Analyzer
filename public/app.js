let validatedPath = '';
let generatedStoryId = '';

// Load saved projects on page load
document.addEventListener('DOMContentLoaded', loadSavedProjects);

function loadSavedProjects() {
  var projects = JSON.parse(localStorage.getItem('savedProjects') || '[]');
  var container = document.getElementById('savedProjects');
  container.innerHTML = '';

  if (projects.length === 0) {
    container.innerHTML = '<p class="no-projects">No saved projects yet. Add one below.</p>';
    return;
  }

  projects.forEach(function(proj, index) {
    var item = document.createElement('div');
    item.className = 'project-item';
    item.onclick = function() { selectProject(proj.path); };
    item.innerHTML =
      '<div class="project-info">' +
        '<span class="project-name">' + proj.name + '</span>' +
        '<span class="project-path">' + proj.path + '</span>' +
      '</div>' +
      '<button class="project-delete" onclick="event.stopPropagation(); deleteProject(' + index + ')" title="Remove">✕</button>';
    container.appendChild(item);
  });
}

function saveProject() {
  var repoPath = document.getElementById('repoPath').value.trim();
  var projectName = document.getElementById('projectName').value.trim();

  if (!repoPath) { alert('Enter a repo path first'); return; }
  if (!projectName) { alert('Enter a project name'); return; }

  var projects = JSON.parse(localStorage.getItem('savedProjects') || '[]');
  var exists = projects.some(function(p) { return p.path === repoPath; });
  if (exists) { alert('This path is already saved'); return; }

  projects.push({ name: projectName, path: repoPath });
  localStorage.setItem('savedProjects', JSON.stringify(projects));
  document.getElementById('projectName').value = '';
  loadSavedProjects();
}

function deleteProject(index) {
  var projects = JSON.parse(localStorage.getItem('savedProjects') || '[]');
  projects.splice(index, 1);
  localStorage.setItem('savedProjects', JSON.stringify(projects));
  loadSavedProjects();
}

function selectProject(projectPath) {
  document.getElementById('repoPath').value = projectPath;
  validatePath();
}

async function validatePath() {
  var repoPath = document.getElementById('repoPath').value.trim();
  var status = document.getElementById('pathStatus');

  if (!repoPath) { showStatus(status, 'Please enter a repository path', 'error'); return; }

  var btn = document.getElementById('validateBtn');
  btn.disabled = true; btn.textContent = 'Checking...';

  try {
    var res = await fetch('/api/validate-path', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath })
    });
    var data = await res.json();
    if (data.valid) {
      validatedPath = data.path;
      showStatus(status, '✓ Valid git repository', 'success');
      document.getElementById('step2').classList.remove('hidden');
      fetchBranches(); // Auto-load branches
    } else {
      showStatus(status, '✗ ' + data.error, 'error');
    }
  } catch (err) { showStatus(status, '✗ ' + err.message, 'error'); }

  btn.disabled = false; btn.textContent = 'Validate';
}

async function prepareRepo() {
  // This is now handled by the dynamic branch selection
  fetchBranches();
}

// Branch data store
let allBranches = [];
let selectedBranch = '';

async function fetchBranches() {
  var branchList = document.getElementById('branchList');
  branchList.innerHTML = '<p class="card-desc">Loading branches...</p>';

  try {
    var res = await fetch('/api/branches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: validatedPath })
    });
    var data = await res.json();

    if (data.success) {
      allBranches = data.branches;
      document.getElementById('currentBranch').classList.remove('hidden');
      document.getElementById('currentBranch').textContent = '📍 Current branch: ' + data.current;
      renderBranches(allBranches);
    } else {
      branchList.innerHTML = '<p class="status error">' + data.error + '</p>';
    }
  } catch (err) {
    branchList.innerHTML = '<p class="status error">' + err.message + '</p>';
  }
}

function renderBranches(branches) {
  var branchList = document.getElementById('branchList');
  if (branches.length === 0) {
    branchList.innerHTML = '<p class="card-desc">No branches found matching filter.</p>';
    return;
  }

  var html = '';
  branches.slice(0, 30).forEach(function(b) {
    html += '<div class="branch-item" onclick="selectBranch(\'' + b.name.replace(/'/g, "\\'") + '\')">' +
      '<div class="branch-info">' +
        '<span class="branch-name">' + b.name + '</span>' +
        '<span class="branch-meta">' + b.author + ' • ' + b.date + '</span>' +
      '</div>' +
      '<span class="branch-arrow">→</span>' +
    '</div>';
  });

  if (branches.length > 30) {
    html += '<p class="card-desc">Showing 30 of ' + branches.length + ' branches. Type to filter.</p>';
  }

  branchList.innerHTML = html;
}

function filterBranches() {
  var query = document.getElementById('branchSearch').value.toLowerCase();
  var filtered = allBranches.filter(function(b) {
    return b.name.toLowerCase().includes(query);
  });
  renderBranches(filtered);
}

function filterByAuthor() {
  var author = document.getElementById('authorFilter').value.toLowerCase();
  var query = document.getElementById('branchSearch').value.toLowerCase();
  var filtered = allBranches.filter(function(b) {
    var matchAuthor = !author || b.author.toLowerCase().includes(author);
    var matchName = !query || b.name.toLowerCase().includes(query);
    return matchAuthor && matchName;
  });
  renderBranches(filtered);
}

async function selectBranch(branch) {
  selectedBranch = branch;
  var status = document.getElementById('branchStatus');
  showStatus(status, 'Switching to ' + branch + '...', 'info');

  // First check if working tree is dirty
  try {
    var statusRes = await fetch('/api/git-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: validatedPath })
    });
    var statusData = await statusRes.json();

    if (statusData.dirty) {
      // Show stash prompt
      document.getElementById('stashPrompt').classList.remove('hidden');
      showStatus(status, '⚠️ Uncommitted changes detected', 'error');
      return;
    }

    // No dirty files, checkout directly
    await doCheckout(branch);
  } catch (err) {
    showStatus(status, '✗ ' + err.message, 'error');
  }
}

async function stashAndCheckout() {
  var status = document.getElementById('branchStatus');
  showStatus(status, 'Stashing changes...', 'info');

  try {
    var res = await fetch('/api/git-stash', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: validatedPath })
    });
    var data = await res.json();

    if (data.success) {
      document.getElementById('stashPrompt').classList.add('hidden');
      await doCheckout(selectedBranch);
    } else {
      showStatus(status, '✗ Stash failed: ' + data.error, 'error');
    }
  } catch (err) {
    showStatus(status, '✗ ' + err.message, 'error');
  }
}

function cancelCheckout() {
  document.getElementById('stashPrompt').classList.add('hidden');
  var status = document.getElementById('branchStatus');
  showStatus(status, 'Checkout cancelled', 'info');
}

async function doCheckout(branch) {
  var status = document.getElementById('branchStatus');
  showStatus(status, 'Checking out ' + branch + '...', 'info');

  try {
    var res = await fetch('/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: validatedPath, branch: branch })
    });
    var data = await res.json();

    if (data.success) {
      showStatus(status, '✓ ' + data.message, 'success');
      document.getElementById('currentBranch').textContent = '📍 Current branch: ' + branch;
      // Show next steps
      document.getElementById('step3').classList.remove('hidden');
      document.getElementById('step4').classList.remove('hidden');
      document.getElementById('step5').classList.remove('hidden');
      document.getElementById('step6').classList.remove('hidden');
    } else if (data.needsStash) {
      document.getElementById('stashPrompt').classList.remove('hidden');
      showStatus(status, '⚠️ ' + data.error, 'error');
    } else {
      showStatus(status, '✗ ' + data.error, 'error');
    }
  } catch (err) {
    showStatus(status, '✗ ' + err.message, 'error');
  }
}

async function analyze() {
  var storyContent = document.getElementById('storyContent').value.trim();
  if (!storyContent) { alert('Paste the Jira story content first!'); return; }
  if (!validatedPath) { alert('Validate repo path first!'); return; }

  var additionalPoints = document.getElementById('additionalPoints').value.trim();
  var assignee = document.getElementById('assignee').value.trim() || 'TBD';
  var devDate = document.getElementById('devDate').value || 'TBD';
  var uatDate = document.getElementById('uatDate').value || 'TBD';

  var btn = document.getElementById('analyzeBtn');
  btn.disabled = true; btn.textContent = 'Preparing...';

  // Show terminal
  var terminalCard = document.getElementById('terminalCard');
  var terminal = document.getElementById('terminal');
  terminalCard.classList.remove('hidden');
  terminal.innerHTML = '';
  appendTerminal('system', '▶ Scanning codebase and building prompt...');

  try {
    // Step 1: Build prompt
    var res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: validatedPath, storyContent, additionalPoints, assignee, devDate, uatDate })
    });
    var data = await res.json();

    if (!data.success) {
      appendTerminal('error', '✗ ' + data.error);
      btn.disabled = false; btn.textContent = '⚡ Generate with Kiro';
      return;
    }

    generatedStoryId = data.storyId || 'STORY';
    appendTerminal('system', '✓ Prompt ready. Tech: ' + data.stack.languages.join(', ') + ' | ' + data.stack.frameworks.join(', '));
    appendTerminal('system', '▶ Starting kiro-cli...');
    btn.textContent = 'Kiro working...';

    // Step 2: Stream kiro output
    var response = await fetch('/api/run-kiro', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: validatedPath, prompt: data.prompt })
    });

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.startsWith('data: ')) {
          try {
            var event = JSON.parse(line.substring(6));
            if (event.type === 'stdout') appendTerminal('stdout', event.text);
            else if (event.type === 'stderr') appendTerminal('stderr', event.text);
            else if (event.type === 'error') appendTerminal('error', '✗ ' + event.text);
            else if (event.type === 'done') {
              appendTerminal('system', '✓ Kiro finished (exit: ' + event.code + ')');
              showResult();
            }
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    appendTerminal('error', '✗ ' + err.message);
  }

  btn.disabled = false; btn.textContent = '⚡ Generate with Kiro';
}

function showResult() {
  var resultDiv = document.getElementById('resultContent');
  resultDiv.innerHTML =
    '<p>Files generated in <code>development-effort/</code> folder.</p>' +
    '<p>Story: <code>' + generatedStoryId + '</code></p>';
  document.getElementById('result').classList.remove('hidden');
}

function downloadGenerated(type) {
  var storyId = generatedStoryId || 'STORY';
  var filename = type === 'wbs' ? 'WBS_' + storyId + '.md' : 'Impact_Analysis_' + storyId + '.md';

  // Fetch file from server
  fetch('/api/download?path=' + encodeURIComponent(validatedPath) + '&file=' + encodeURIComponent(filename))
    .then(function(res) { return res.blob(); })
    .then(function(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })
    .catch(function(err) { alert('File not found. Kiro may have used a different filename.'); });
}

function appendTerminal(type, text) {
  var terminal = document.getElementById('terminal');
  var div = document.createElement('div');
  div.className = 'line-' + type;
  div.textContent = text;
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

function showStatus(el, message, type) {
  el.classList.remove('hidden');
  el.textContent = message;
  el.className = 'status ' + type;
}


// Mobile nav toggle
function toggleNav() {
  var nav = document.getElementById('navLinks');
  nav.classList.toggle('open');
}

// Fullscreen modal controls
function openAnalyzer() {
  document.getElementById('analyzerModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeAnalyzer() {
  document.getElementById('analyzerModal').classList.add('hidden');
  document.body.style.overflow = '';
}
