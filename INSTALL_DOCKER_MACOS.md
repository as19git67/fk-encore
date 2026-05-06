# Docker engine on macos

```
brew install docker colima
```

```
start colima vm setting up the specs, in this case
colima start --cpu 1 --memory 2
```

```
use docker as usual
docker ps -a
```

```
# stop colima vm
colima stop
```

```
# docker-compose is optional
brew install docker docker-compose colima
```
