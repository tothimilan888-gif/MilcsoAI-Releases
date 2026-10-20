fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'milcsoguard'
author 'MilcsoGuard'
description 'MilcsoGuard – server-authoritative anticheat with in-game admin panel'
version '1.1.0'
repository 'https://github.com/tothimilan888-gif/MilcsoAI-Releases'

-- Nothing in server_scripts (config, API key handling) is ever sent to clients.
shared_scripts {
    'shared/util.lua',
    'shared/ratelimit.lua',
}

server_scripts {
    'config/config.lua',
    'server/core/logger.lua',
    'server/core/config_check.lua',
    'server/core/weapons.lua',
    'server/core/risk.lua',
    'server/core/schema.lua',
    'server/core/state.lua',
    'server/core/scheduler.lua',
    'bridge/framework.lua',
    'server/core/permissions.lua',
    'server/core/api.lua',
    'server/core/bans.lua',
    'server/core/detections.lua',
    'server/core/sync.lua',
    'server/core/replay.lua',
    'server/modules/movement.lua',
    'server/modules/player.lua',
    'server/modules/weapons.lua',
    'server/modules/entities.lua',
    'server/modules/events.lua',
    'server/modules/resources.lua',
    'server/admin/panel.lua',
    'server/main.lua',
}

client_scripts {
    'client/main.lua',
    'client/admin.lua',
    'client/replay.lua',
}

ui_page 'nui/index.html'

files {
    'nui/index.html',
    'nui/style.css',
    'nui/app.js',
    'nui/brand.js',
    'nui/replay.js',
}

-- OneSync is required for the server-side checks; the resource reports clearly when it is off.
