const fs = require('fs');
const path = require('path');

function analyzeCodebase(repoPath) {
  const result = {
    controllers: [],
    services: [],
    repositories: [],
    entities: [],
    dtos: [],
    configs: [],
    migrations: [],
    events: [],
    tests: [],
    apis: [],
    totalFiles: 0,
    structure: {}
  };

  scanDirectory(repoPath, repoPath, result);
  return result;
}

function scanDirectory(basePath, currentPath, result, depth = 0) {
  if (depth > 8) return;

  const ignoreDirs = ['node_modules', '.git', 'target', 'build', 'dist', '.idea', '.vscode', '__pycache__', 'vendor'];

  let entries;
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      if (ignoreDirs.includes(entry.name)) continue;
      scanDirectory(basePath, fullPath, result, depth + 1);
    } else if (entry.isFile()) {
      result.totalFiles++;
      categorizeFile(relativePath, entry.name, result);
    }
  }
}

function categorizeFile(relativePath, fileName, result) {
  const lower = fileName.toLowerCase();
  const relLower = relativePath.toLowerCase();

  // Controllers
  if (lower.includes('controller') || relLower.includes('/controller')) {
    result.controllers.push(relativePath);
  }

  // Services
  if ((lower.includes('service') && !lower.includes('test')) || relLower.includes('/service/')) {
    result.services.push(relativePath);
  }

  // Repositories
  if (lower.includes('repository') || lower.includes('repo') || relLower.includes('/repository/')) {
    result.repositories.push(relativePath);
  }

  // Entities / Models
  if (lower.includes('entity') || lower.includes('model') || relLower.includes('/entity/') || relLower.includes('/model/')) {
    result.entities.push(relativePath);
  }

  // DTOs
  if (lower.includes('dto') || lower.includes('request') || lower.includes('response') || relLower.includes('/dto/')) {
    result.dtos.push(relativePath);
  }

  // Configs
  if (lower.includes('config') || lower.includes('configuration') || relLower.includes('/config/')) {
    result.configs.push(relativePath);
  }

  // Migrations
  if (lower.includes('migration') || lower.includes('flyway') || lower.includes('liquibase') || relLower.includes('/migration/') || relLower.includes('/db/')) {
    result.migrations.push(relativePath);
  }

  // Events / Kafka
  if (lower.includes('event') || lower.includes('kafka') || lower.includes('consumer') || lower.includes('producer') || lower.includes('listener')) {
    result.events.push(relativePath);
  }

  // Tests
  if (lower.includes('test') || lower.includes('spec') || relLower.includes('/test/')) {
    result.tests.push(relativePath);
  }

  // API definitions
  if (lower.includes('api') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.includes('swagger') || lower.includes('openapi')) {
    result.apis.push(relativePath);
  }
}

module.exports = { analyzeCodebase };
