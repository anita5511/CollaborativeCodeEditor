const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const auth = require('../middleware/auth');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

// Get GitHub repositories
router.get('/repositories', auth, async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({ error: 'GitHub token is required' });
    }

    const response = await axios.get('https://api.github.com/user/repos', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      },
      params: {
        sort: 'updated',
        per_page: 100
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching GitHub repositories:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

// Import GitHub repository
router.post('/import', auth, async (req, res) => {
  try {
    const { repoUrl, repoName, description, githubToken, defaultBranch } = req.body;
    const userId = req.user.id;

    if (!repoUrl || !repoName || !githubToken) {
      return res.status(400).json({ error: 'Repository URL, name, and GitHub token are required' });
    }

    // Create project record
    const projectResult = await pool.query(
      `INSERT INTO github_projects (owner_id, name, description, github_url, github_token, default_branch, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'cloning') 
       RETURNING *`,
      [userId, repoName, description || '', repoUrl, githubToken, defaultBranch || 'main']
    );

    const project = projectResult.rows[0];

    // Start cloning process in background
    cloneRepository(project.id, repoUrl, githubToken, defaultBranch || 'main')
      .catch(error => {
        console.error('Error cloning repository:', error);
        // Update status to error
        pool.query(
          'UPDATE github_projects SET status = $1 WHERE id = $2',
          ['error', project.id]
        );
      });

    res.json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
        status: project.status
      }
    });

  } catch (error) {
    console.error('Error importing GitHub repository:', error);
    res.status(500).json({ error: 'Failed to import repository' });
  }
});

// Get GitHub projects
router.get('/projects', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT gp.*, 
              COUNT(gpf.id) as file_count
       FROM github_projects gp
       LEFT JOIN github_project_files gpf ON gp.id = gpf.project_id
       WHERE gp.owner_id = $1
       GROUP BY gp.id
       ORDER BY gp.updated_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM github_projects WHERE owner_id = $1',
      [userId]
    );

    res.json({
      projects: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit
    });
  } catch (error) {
    console.error('Error fetching GitHub projects:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub projects' });
  }
});

// Get specific GitHub project
router.get('/projects/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const projectResult = await pool.query(
      'SELECT * FROM github_projects WHERE id = $1 AND owner_id = $2',
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'GitHub project not found' });
    }

    const filesResult = await pool.query(
      'SELECT * FROM github_project_files WHERE project_id = $1 ORDER BY relative_path',
      [id]
    );

    const project = projectResult.rows[0];
    project.files = filesResult.rows;

    res.json(project);
  } catch (error) {
    console.error('Error fetching GitHub project:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub project' });
  }
});

// Get file content
router.get('/projects/:id/files/:filePath(*)', auth, async (req, res) => {
  try {
    const { id, filePath } = req.params;
    const userId = req.user.id;

    const projectResult = await pool.query(
      'SELECT * FROM github_projects WHERE id = $1 AND owner_id = $2',
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'GitHub project not found' });
    }

    const project = projectResult.rows[0];
    const fullPath = path.join(project.extract_path, filePath);

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      res.json({ content });
    } catch (fileError) {
      console.error('Error reading file:', fileError);
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    console.error('Error getting file content:', error);
    res.status(500).json({ error: 'Failed to get file content' });
  }
});

// Update file content
router.put('/projects/:id/files/:filePath(*)', auth, async (req, res) => {
  try {
    const { id, filePath } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    const projectResult = await pool.query(
      'SELECT * FROM github_projects WHERE id = $1 AND owner_id = $2',
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'GitHub project not found' });
    }

    const project = projectResult.rows[0];
    const fullPath = path.join(project.extract_path, filePath);

    await fs.writeFile(fullPath, content, 'utf8');

    // Update project timestamp
    await pool.query(
      'UPDATE github_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating file:', error);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

// Commit changes to GitHub
router.post('/projects/:id/commit', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { commitMessage, commitDescription, changedFiles } = req.body;
    const userId = req.user.id;

    const projectResult = await pool.query(
      'SELECT * FROM github_projects WHERE id = $1 AND owner_id = $2',
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'GitHub project not found' });
    }

    const project = projectResult.rows[0];

    // Write changed files to disk
    for (const file of changedFiles) {
      const fullPath = path.join(project.extract_path, file.filePath);
      await fs.writeFile(fullPath, file.content, 'utf8');
    }

    // Commit and push to GitHub
    const repoPath = project.extract_path;
    
    try {
      // Configure git user (use GitHub token for authentication)
      execSync('git config user.email "codespace@example.com"', { cwd: repoPath });
      execSync('git config user.name "CodeSpace"', { cwd: repoPath });
      
      // Add changed files
      for (const file of changedFiles) {
        execSync(`git add "${file.filePath}"`, { cwd: repoPath });
      }
      
      // Commit changes
      const fullCommitMessage = commitDescription 
        ? `${commitMessage}\n\n${commitDescription}`
        : commitMessage;
      
      execSync(`git commit -m "${fullCommitMessage.replace(/"/g, '\\"')}"`, { cwd: repoPath });
      
      // Push to GitHub
      const repoUrlWithToken = project.github_url.replace(
        'https://github.com/',
        `https://${project.github_token}@github.com/`
      );
      
      execSync(`git push "${repoUrlWithToken}" ${project.default_branch}`, { cwd: repoPath });
      
      res.json({ success: true, message: 'Changes committed successfully' });
      
    } catch (gitError) {
      console.error('Git operation failed:', gitError);
      res.status(500).json({ error: 'Failed to commit changes to GitHub' });
    }

  } catch (error) {
    console.error('Error committing to GitHub:', error);
    res.status(500).json({ error: 'Failed to commit changes' });
  }
});

// Delete GitHub project
router.delete('/projects/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const projectResult = await pool.query(
      'SELECT * FROM github_projects WHERE id = $1 AND owner_id = $2',
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'GitHub project not found' });
    }

    const project = projectResult.rows[0];

    // Delete files from filesystem
    if (project.extract_path) {
      try {
        await fs.rmdir(project.extract_path, { recursive: true });
      } catch (fsError) {
        console.error('Error deleting project files:', fsError);
      }
    }

    // Delete from database
    await pool.query('DELETE FROM github_projects WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting GitHub project:', error);
    res.status(500).json({ error: 'Failed to delete GitHub project' });
  }
});

// Helper function to clone repository
async function cloneRepository(projectId, repoUrl, githubToken, branch) {
  try {
    const extractPath = path.join(process.cwd(), 'github_projects', projectId);
    
    // Create directory
    await fs.mkdir(extractPath, { recursive: true });
    
    // Clone repository with token authentication
    const repoUrlWithToken = repoUrl.replace(
      'https://github.com/',
      `https://${githubToken}@github.com/`
    );
    
    execSync(`git clone -b ${branch} "${repoUrlWithToken}" .`, { 
      cwd: extractPath,
      stdio: 'inherit'
    });
    
    // Update project with extract path and status
    await pool.query(
      'UPDATE github_projects SET extract_path = $1, status = $2 WHERE id = $3',
      [extractPath, 'ready', projectId]
    );
    
    // Index files
    await indexGitHubProjectFiles(projectId, extractPath);
    
  } catch (error) {
    console.error('Error cloning repository:', error);
    await pool.query(
      'UPDATE github_projects SET status = $1 WHERE id = $2',
      ['error', projectId]
    );
    throw error;
  }
}

// Helper function to index project files
async function indexGitHubProjectFiles(projectId, extractPath) {
  const indexDirectory = async (dirPath, relativePath = '') => {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const item of items) {
      // Skip .git directory
      if (item.name === '.git') continue;
      
      const itemPath = path.join(dirPath, item.name);
      const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
      
      if (item.isDirectory()) {
        // Insert directory record
        await pool.query(
          `INSERT INTO github_project_files (project_id, relative_path, is_directory) 
           VALUES ($1, $2, $3)`,
          [projectId, itemRelativePath, true]
        );
        
        // Recursively index subdirectory
        await indexDirectory(itemPath, itemRelativePath);
      } else {
        // Get file stats
        const stats = await fs.stat(itemPath);
        
        // Insert file record
        await pool.query(
          `INSERT INTO github_project_files (project_id, relative_path, is_directory, size) 
           VALUES ($1, $2, $3, $4)`,
          [projectId, itemRelativePath, false, stats.size]
        );
      }
    }
  };
  
  await indexDirectory(extractPath);
}

module.exports = router;