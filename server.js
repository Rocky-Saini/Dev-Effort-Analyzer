const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { execSync, spawn } = require('child_process');
const { analyzeCodebase } = require('./analyzer');

const PORT = 3500;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json'
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'text/plain';

  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': mime });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function detectTechStack(repoPath) {
  const stack = { languages: [], frameworks: [], databases: [], messaging: [], build: [] };

  const checks = [
    { file: 'package.json', lang: 'JavaScript/TypeScript', framework: null },
    { file: 'pom.xml', lang: 'Java', framework: 'Spring Boot' },
    { file: 'build.gradle', lang: 'Java/Kotlin', framework: 'Spring Boot' },
    { file: 'requirements.txt', lang: 'Python', framework: null },
    { file: 'go.mod', lang: 'Go', framework: null },
    { file: 'tsconfig.json', lang: 'TypeScript', framework: null },
    { file: 'angular.json', lang: 'TypeScript', framework: 'Angular' },
    { file: 'docker-compose.yml', lang: null, framework: null, build: 'Docker' },
    { file: 'Dockerfile', lang: null, framework: null, build: 'Docker' },
  ];

  checks.forEach(({ file, lang, framework, build }) => {
    if (fs.existsSync(path.join(repoPath, file))) {
      if (lang && !stack.languages.includes(lang)) stack.languages.push(lang);
      if (framework && !stack.frameworks.includes(framework)) stack.frameworks.push(framework);
      if (build && !stack.build.includes(build)) stack.build.push(build);
    }
  });

  const configFiles = ['application.yml', 'application.properties', '.env', 'docker-compose.yml'];
  configFiles.forEach(cf => {
    const fp = path.join(repoPath, cf);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf-8').toLowerCase();
      if (content.includes('postgres')) stack.databases.push('PostgreSQL');
      if (content.includes('mysql')) stack.databases.push('MySQL');
      if (content.includes('mongo')) stack.databases.push('MongoDB');
      if (content.includes('redis')) stack.databases.push('Redis');
      if (content.includes('kafka')) stack.messaging.push('Kafka');
      if (content.includes('rabbitmq')) stack.messaging.push('RabbitMQ');
    }
  });

  if (fs.existsSync(path.join(repoPath, 'src', 'main'))) {
    if (!stack.frameworks.includes('Spring Boot')) stack.frameworks.push('Spring Boot');
  }

  stack.databases = [...new Set(stack.databases)];
  stack.messaging = [...new Set(stack.messaging)];
  return stack;
}

function extractStoryId(content) {
  const match = content.match(/([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

// Build the refined prompt for Kiro
function buildKiroPrompt(storyContent, additionalPoints, codebaseInfo, stack, meta) {
  const storyId = extractStoryId(storyContent) || 'STORY';
  const outputDir = path.join(meta.repoPath, 'development-effort');

  let prompt = `You are analyzing a codebase for JIRA ticket ${storyId}.

## JIRA Story Content:
${storyContent}

## Additional Developer Notes:
${additionalPoints || 'None provided'}

## Developer Info:
- Assignee: ${meta.assignee}
- DEV Target Date: ${meta.devDate}
- UAT Target Date: ${meta.uatDate}

## Tech Stack Detected:
- Languages: ${stack.languages.join(', ') || 'N/A'}
- Frameworks: ${stack.frameworks.join(', ') || 'N/A'}
- Databases: ${stack.databases.join(', ') || 'N/A'}
- Messaging: ${stack.messaging.join(', ') || 'N/A'}

## Codebase Analysis (auto-scanned):
- Controllers (${codebaseInfo.controllers.length}): ${codebaseInfo.controllers.slice(0, 10).join(', ')}
- Services (${codebaseInfo.services.length}): ${codebaseInfo.services.slice(0, 10).join(', ')}
- Repositories (${codebaseInfo.repositories.length}): ${codebaseInfo.repositories.slice(0, 10).join(', ')}
- Entities (${codebaseInfo.entities.length}): ${codebaseInfo.entities.slice(0, 10).join(', ')}
- DTOs (${codebaseInfo.dtos.length}): ${codebaseInfo.dtos.slice(0, 10).join(', ')}
- Events/Kafka (${codebaseInfo.events.length}): ${codebaseInfo.events.slice(0, 10).join(', ')}
- Configs (${codebaseInfo.configs.length}): ${codebaseInfo.configs.slice(0, 10).join(', ')}
- Migrations (${codebaseInfo.migrations.length}): ${codebaseInfo.migrations.slice(0, 10).join(', ')}

## YOUR TASK:
Based on the above JIRA story, developer notes, and codebase analysis, generate TWO files:

### File 1: ${outputDir}/WBS_${storyId}.md
Generate a Work Breakdown Structure in this format:
- Table with columns: JIRA Ticket | Assignee | Total Efforts | DEV Date | UAT Date
- Detailed task breakdown with effort hours for each task
- Include buffer hours for: Dev Testing, Testing Scope Definition, Impact Analysis, UAT Testing, Preprod movement
- Branch & Commit Guidelines
- Dependencies section

### File 2: ${outputDir}/Impact_Analysis_${storyId}.md
Generate Impact Analysis in this email-ready format:
- Ticket No: ${storyId}
- Short Task Description: (derive from story)
- Short Impact Analysis: (1-2 line summary)
- Detailed Impact Analysis: (comprehensive - what changes, what's affected, upstream/downstream dependencies, DB impact, event impact, regression risks, rollback plan, testing recommendations)

Search the codebase thoroughly for files related to this story. Look for relevant keywords, similar implementations, and affected modules. Be specific about which files will change.

Create the folder "${outputDir}" if it doesn't exist, then write both files there.`;

  return prompt;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // API: Validate path
  if (req.method === 'POST' && parsed.pathname === '/api/validate-path') {
    const { repoPath } = await parseBody(req);
    if (!repoPath) return sendJson(res, { valid: false, error: 'Path is required' });
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved)) return sendJson(res, { valid: false, error: 'Path does not exist' });
    if (!fs.existsSync(path.join(resolved, '.git'))) return sendJson(res, { valid: false, error: 'Not a git repository' });
    return sendJson(res, { valid: true, path: resolved });
  }

  // API: Prepare repo (legacy - kept for compatibility)
  if (req.method === 'POST' && parsed.pathname === '/api/prepare-repo') {
    const { repoPath, branch } = await parseBody(req);
    const resolved = path.resolve(repoPath);
    try {
      execSync(`git checkout ${branch || 'integration-03'}`, { cwd: resolved, stdio: 'pipe' });
      execSync(`git pull origin ${branch || 'integration-03'}`, { cwd: resolved, stdio: 'pipe' });
      return sendJson(res, { success: true, message: `Checked out ${branch || 'integration-03'} and pulled latest` });
    } catch (err) {
      return sendJson(res, { success: false, error: err.stderr ? err.stderr.toString() : err.message });
    }
  }

  // API: Fetch all branches
  if (req.method === 'POST' && parsed.pathname === '/api/branches') {
    const { repoPath } = await parseBody(req);
    const resolved = path.resolve(repoPath);
    try {
      // Fetch latest refs
      try { execSync('git fetch --all --prune', { cwd: resolved, stdio: 'pipe', timeout: 15000 }); } catch (e) {}

      // Get all branches with author info
      const raw = execSync(
        'git for-each-ref --sort=-committerdate refs/heads refs/remotes --format="%(refname:short)|%(authorname)|%(committerdate:relative)"',
        { cwd: resolved, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }
      ).toString().trim();

      const branches = raw.split('\n').filter(Boolean).map(line => {
        const [name, author, date] = line.split('|');
        return { name: name.replace('origin/', ''), author: author || '', date: date || '' };
      });

      // Deduplicate
      const seen = new Set();
      const unique = branches.filter(b => {
        if (seen.has(b.name)) return false;
        seen.add(b.name);
        return true;
      });

      // Current branch
      const current = execSync('git branch --show-current', { cwd: resolved, stdio: 'pipe' }).toString().trim();

      return sendJson(res, { success: true, branches: unique, current });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  // API: Check if working tree is dirty
  if (req.method === 'POST' && parsed.pathname === '/api/git-status') {
    const { repoPath } = await parseBody(req);
    const resolved = path.resolve(repoPath);
    try {
      const status = execSync('git status --porcelain', { cwd: resolved, stdio: 'pipe' }).toString().trim();
      return sendJson(res, { success: true, dirty: status.length > 0, changes: status });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  // API: Stash changes
  if (req.method === 'POST' && parsed.pathname === '/api/git-stash') {
    const { repoPath } = await parseBody(req);
    const resolved = path.resolve(repoPath);
    try {
      execSync('git stash push -m "DevEffort auto-stash"', { cwd: resolved, stdio: 'pipe' });
      return sendJson(res, { success: true, message: 'Changes stashed successfully' });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  // API: Checkout branch
  if (req.method === 'POST' && parsed.pathname === '/api/checkout') {
    const { repoPath, branch } = await parseBody(req);
    const resolved = path.resolve(repoPath);
    try {
      execSync(`git checkout ${branch}`, { cwd: resolved, stdio: 'pipe' });
      try { execSync(`git pull origin ${branch}`, { cwd: resolved, stdio: 'pipe', timeout: 15000 }); } catch (e) {}
      return sendJson(res, { success: true, message: `Switched to ${branch} and pulled latest` });
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString() : err.message;
      // Check if it's a dirty working tree issue
      if (errMsg.includes('uncommitted') || errMsg.includes('overwritten') || errMsg.includes('conflict')) {
        return sendJson(res, { success: false, needsStash: true, error: errMsg });
      }
      return sendJson(res, { success: false, error: errMsg });
    }
  }

  // API: Analyze - returns prompt and starts kiro-cli via SSE
  if (req.method === 'POST' && parsed.pathname === '/api/analyze') {
    const { repoPath, storyContent, additionalPoints, assignee, devDate, uatDate } = await parseBody(req);
    const resolved = path.resolve(repoPath);

    try {
      const codebaseInfo = analyzeCodebase(resolved);
      const stack = detectTechStack(resolved);
      const meta = { repoPath: resolved, assignee: assignee || 'TBD', devDate: devDate || 'TBD', uatDate: uatDate || 'TBD' };
      const prompt = buildKiroPrompt(storyContent, additionalPoints, codebaseInfo, stack, meta);

      return sendJson(res, { success: true, prompt, stack, storyId: extractStoryId(storyContent) || 'STORY' });
    } catch (err) {
      return sendJson(res, { success: false, error: err.message });
    }
  }

  // API: Execute kiro-cli with SSE (Server-Sent Events for live terminal output)
  if (req.method === 'POST' && parsed.pathname === '/api/run-kiro') {
    const { repoPath, prompt } = await parseBody(req);
    const resolved = path.resolve(repoPath);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Write prompt to a temp file to avoid argument length limits
    const promptFile = path.join(resolved, '.kiro-prompt-tmp.txt');
    fs.writeFileSync(promptFile, prompt);

    // Use kiro-cli chat with prompt as argument, non-interactive, trust all tools
    const kiro = spawn('kiro-cli', [
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      fs.readFileSync(promptFile, 'utf-8')
    ], {
      cwd: resolved,
      env: { ...process.env }
    });

    kiro.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          res.write('data: ' + JSON.stringify({ type: 'stdout', text: line }) + '\n\n');
        }
      });
    });

    kiro.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          res.write('data: ' + JSON.stringify({ type: 'stderr', text: line }) + '\n\n');
        }
      });
    });

    kiro.on('close', (code) => {
      try { fs.unlinkSync(promptFile); } catch (e) {}
      res.write('data: ' + JSON.stringify({ type: 'done', code }) + '\n\n');
      res.end();
    });

    kiro.on('error', (err) => {
      try { fs.unlinkSync(promptFile); } catch (e) {}
      res.write('data: ' + JSON.stringify({ type: 'error', text: err.message }) + '\n\n');
      res.end();
    });

    req.on('close', () => {
      kiro.kill();
      try { fs.unlinkSync(promptFile); } catch (e) {}
    });

    return;
  }

  // API: Download generated file
  if (req.method === 'GET' && parsed.pathname === '/api/download') {
    const filePath = parsed.query.path;
    const fileName = parsed.query.file;
    if (!filePath || !fileName) {
      res.writeHead(400); res.end('Missing params'); return;
    }
    const fullPath = path.join(filePath, 'development-effort', fileName);
    if (fs.existsSync(fullPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/markdown',
        'Content-Disposition': 'attachment; filename="' + fileName + '"'
      });
      res.end(fs.readFileSync(fullPath));
    } else {
      res.writeHead(404); res.end('File not found');
    }
    return;
  }

  // Serve static files
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Dev Effort Analyzer running at http://localhost:${PORT}`);
});
