module.exports = {
  apps: [{
    name:          'solarpayg',
    script:        'server.js',
    instances:     'max',        // one process per CPU core (8 here)
    exec_mode:     'cluster',    // Node cluster — shared port, load-balanced
    watch:         false,
    max_memory_restart: '400M',  // restart a worker if it leaks past 400 MB

    env: {
      NODE_ENV: 'development',
      PORT:     3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT:     3000
    },

    /* Graceful shutdown — finish in-flight requests before stopping */
    kill_timeout:       5000,
    wait_ready:         true,
    listen_timeout:     10000,

    /* Auto-restart on crash, with exponential back-off */
    autorestart:        true,
    restart_delay:      1000,
    max_restarts:       10,

    /* Logs */
    out_file:  './logs/out.log',
    error_file:'./logs/error.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
