const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const initDatabase = async () => {
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create files table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        iv TEXT,
        auth_tag TEXT,
        encrypted BOOLEAN DEFAULT TRUE,
        owner_id UUID REFERENCES users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create shares table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shares (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id UUID REFERENCES files(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE
      );
    `);

    // Create user_files table for tracking which users have access to which files
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_files (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        file_id UUID REFERENCES files(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'read',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, file_id)
      );
    `);

    // Create music_metadata tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS music_metadata (
        file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        artist TEXT,
        album TEXT,
        cover TEXT,
        lyrics TEXT
      );
    `);

    // OTP table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create podcast_sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS podcast_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        host_id UUID NOT NULL,
        meeting_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        records_file_url TEXT
      );
    `);

    // Face data table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS face_data (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        descriptor JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // podcast recordings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recordings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        session_id UUID NOT NULL REFERENCES podcast_sessions(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        video_number INTEGER NOT NULL,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ,
        video_url TEXT
      );
    `);

    // Video metadata table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS video_metadata (
        file_id     UUID        PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        title       TEXT        NOT NULL,
        description TEXT,
        duration    INTEGER,
        thumbnail   TEXT,
        resolution  TEXT,
        codec       TEXT,
        created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        ip_address TEXT NOT NULL,
        device_id TEXT NOT NULL,
        jwt_id TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        revoked BOOLEAN DEFAULT FALSE
      );
    `);

    // New: short‐lived play links table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS play_links (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Projects table (for ZIP uploads)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        zip_path TEXT NOT NULL,
        extract_path TEXT,
        status TEXT NOT NULL DEFAULT 'uploaded',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Project files table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        is_directory BOOLEAN NOT NULL DEFAULT FALSE,
        size INTEGER,
        mime_type TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // GitHub projects table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS github_projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        github_url TEXT NOT NULL,
        github_token TEXT NOT NULL,
        default_branch TEXT DEFAULT 'main',
        extract_path TEXT,
        status TEXT NOT NULL DEFAULT 'cloning',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // GitHub project files table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS github_project_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES github_projects(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        is_directory BOOLEAN NOT NULL DEFAULT FALSE,
        size INTEGER,
        mime_type TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Codespace share table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS codespace_share (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        permission TEXT NOT NULL DEFAULT 'read',
        expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Document versions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS document_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        created_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
      CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_files_path ON project_files(relative_path);
      CREATE INDEX IF NOT EXISTS idx_github_projects_owner_id ON github_projects(owner_id);
      CREATE INDEX IF NOT EXISTS idx_github_project_files_project_id ON github_project_files(project_id);
      CREATE INDEX IF NOT EXISTS idx_github_project_files_path ON github_project_files(relative_path);
      CREATE INDEX IF NOT EXISTS idx_codespace_share_file_id ON codespace_share(file_id);
      CREATE INDEX IF NOT EXISTS idx_codespace_share_token ON codespace_share(token);
      CREATE INDEX IF NOT EXISTS idx_versions_file_id ON document_versions(file_id);
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
};

module.exports = { pool, initDatabase };