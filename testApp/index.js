var application = require('nxus-core').application

require('babel-register')({})

application.start({appDir: process.cwd()+"/testApp"})


