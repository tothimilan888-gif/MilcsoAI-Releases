-- Writes the resource's real settings schema to $OUT (used to seed a demo server through the real handshake).
loadResource()
local f = assert(io.open(os.getenv('OUT'), 'w'))
f:write(json.encode(MG.Schema.descriptor()))
f:close()
