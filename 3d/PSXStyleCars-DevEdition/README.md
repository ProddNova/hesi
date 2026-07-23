# PSXStyleCars runtime pack

Runtime subset copied from:

`C:\Users\giaco\Documents\GitHub\PolyHesi\PSXStyleCars-DevEdition`

It contains the 50 OBJ car bodies and 11 OBJ wheel models used by the game.
Unity prefabs, `.meta` files, FBX duplicates, source textures, demo scenes and
spares are intentionally excluded: the browser does not use them and shipping
them would add roughly 19 MB without changing the playable cars.

The game fetches only the selected body and its wheel model. Nothing in this
directory is preloaded at boot or added to the service worker's core cache.
