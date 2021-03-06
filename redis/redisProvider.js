/**
 * Created by tinyiko on 2017/04/03.
 */
"use strict";

var redis = require("ioredis");
var s2 = require("nodes2ts");
var _  = require("underscore");
var s2common = require("../s2geometry/s2common").s2common;
var logger = require("../config/logutil").logger;

var provider = (function() {

    var TRIP_KEY        = "trip:",
        CITY_CELLS      = "city_cells",
        CELL_KEY        = "cell:",
        VEHICLE_KEY     = "vehicle:";

    //var gridArray = null;
    var client = new redis({
        retryStrategy: function (times) {
            var delay = Math.min(times * 50, 2000);
            return delay;
        }
    });

    client.monitor(function (err, monitor) {
        // Entering monitoring mode.
        monitor.on('monitor', function (time, args, source, database) {
            logger.debug(time + ": " + args);
        });
    });
    /**
     * Create a redis service instance to localhost. Will
     * change to connect to correct environment
     */
    function provider(){
        logger.log("CREATING REDIS PROVIDER()");
        client.on('error',function(err,data){
            if(err.message.startsWith("connect ECONNREFUSED")){
                console.log("server connection failed...");
            };
        });

        client.on("connect",function(){
            console.log("redis server connection succeeded...");
        });
    }


    /**
     *  method to add drivers to grid cells by grid_id
     *  Retrieve the s2 cell that this driver GPS location belongs to (isMemberOfGrid)
     * @param leaf_id
     */
    function S2ArrayToString(array){
        var v = " =[";
        array.forEach(function(item){
            v +=item.id +" = "+item.level()+"|";
        });
        return v+"]";
    }

    //----------methods to add driver position--------------------------
    provider.isMemberOfCityCells = function(item){
        var promise = new Promise(function(resolve,reject){
            client.sismember(CITY_CELLS,item).then(function(results) {
                logger.log("ismember? item = "+ item + ",response = " + results);
                //resolve(item);
                if (results === 1) {
                    //if item is a member of cell, we return the key
                    resolve(item);
                } else if(results === 0){
                    //else we return 0
                    resolve(0)
                    //reject(item);
                }
            }).catch(function(error){
                logger.log('error = '+error);
                reject(error);
            });
        });
        return promise;
    }

    provider.getCellforVehicleKey2 = function(vehicleKey,vehicle_id,cb){
        var cellArray = s2common.getParentIdArray(vehicleKey,12,3);
        var promises = [];
        //client.multi();
        cellArray.forEach(function(item){
            //promises.push(client.sismember(CITY_CELLS,item.pos()));
            promises.push(provider.isMemberOfCityCells(item.pos()))
            logger.log("forEach push promises for item = "+ item.pos());
        });

        Promise.all(promises).then(function(results){
            if(results){
                logger.log("promises running = "+results);
            }
        });
    }

    provider.getCellforVehicleKey = function(vehicleKey,vehicle_id,cb){
        var cellArray = s2common.getParentIdArray(vehicleKey,12,3);
        cellArray.forEach(function(item) {
            (new Promise(function (resolve, reject) {
                resolve(item.pos())
            })).then(function (results) {
                provider.isMemberOfCityCells(results).then(function (cell) {
                    //logger.log("loop2, index = " + "cell=" + cell);
                    if (cell > 0) {
                        logger.log("loop isMember = " + "cell=" + cell);
                        cb(cell);
                    }
                });
            });
        });



        //-------------------------

            /*for(var i = 0; i < cellArray.length; i++){
            var item = cellArray[i].pos();
            provider.isMemberOfCityCells(item).then(function(cell){
                if(cell > 0){
                    logger.log("loop, index = " + i + "cell="+cell);
                    cb(cell);
                }
            }).catch(function(error){
                logger.log("not a member = " + error);
            });
        }*/
    }

    provider.getVehiclePositionByTime = function(vehicle_id,secondsAgo,cb){
        var now = new Date().getTime();
        var before = now - secondsAgo * 1000;
        var minutesAgo = ((secondsAgo * 1000)/60000).toFixed(0);
        logger.log("minutes to go back from NOW --- " +minutesAgo+ "min");
        client.zrangebyscore(VEHICLE_KEY+vehicle_id,before,now,'withscores').then(function(results){
                logger.log("----rangebyscore >>> " +before + ">"+ results.length);
                //logger.log(results);
                cb(results);
        }).catch(function(error){
            logger.log('error = '+error);
        });;
    }

    provider.getVehiclePosition = function(vehicle_id,cb){
            client.zrange(VEHICLE_KEY+vehicle_id,0,-1).then(function(results){
                cb(results);
            }).catch(function(error){
                logger.log('error = '+error);
            });
    }

    provider.getVehiclePositionByRange = function(vehicle,index_start,index_end,cb){
            client.zrange(VEHICLE_KEY+vehicle,index_start,index_end,'withscores').then(function(results){
                logger.log(results);
                cb(results);
            }).catch(function(error){
                logger.log('error = '+error);
            });;
    }

    provider.getVehiclePositionAndScore = function(vehicle_id,cb){
            client.zrange(VEHICLE_KEY+vehicle_id,0,-1,'withscores').then(function(results){
                logger.log(results);
                cb(results);
        }).catch(function(error){
                logger.log('error = '+error);
            });;
    }

    /**
     * This method uses redis transactions to ensure driver_key is added to CELL_KEY
     * and VEHICLE_KEY as an atomic transaction.
     * @param driverKey
     * @param vehicle_id
     * @param timestamp
     */
    provider.addVehiclePosition = function(driverKey,vehicle_id,timestamp){
        //var hexKey = new s2.S2CellId(driverKey).toToken();
        var key = VEHICLE_KEY + vehicle_id;
        provider.getCellforVehicleKey(driverKey,vehicle_id,function(grid_cell){
            logger.log("did we get cell for vehiclekey? = " + grid_cell + "={"+driverKey+"}");
            if(grid_cell > 0) {
                client.multi()
                    .zadd(CELL_KEY + grid_cell,timestamp,vehicle_id)
                    .zadd(key, timestamp, driverKey)
                    .exec().then(function (results) {
                    logger.log("adding " + key +"/key=" +driverKey+"/cell="+grid_cell+", results =" + results);
                }).catch(function(error){
                    logger.log('error = '+error);
                });
            }
        });
    }

    provider.getVehicleCell = function(vehicle_id,cb){
        client.zrange(VEHICLE_KEY+vehicle_id,0,-1).then(function(s2cell_id) {
            var vehicleKey = s2cell_id[0];
            if(vehicleKey === undefined){
                cb(null);
                return;
            }
            logger.log("current cell positions = " + s2cell_id + "-" + vehicleKey);
            var array = s2common.getParentIdArray(vehicleKey, 12, 3);
            //should we also check?? > keys cell:2203795067297071104
            //var promises = new Array();

            array.forEach(function(item){
                (new Promise(function(resolve,reject){
                    resolve(item.pos());
                })).then(function(results){
                    //logger.log("results..."+results);
                    client.sismember(CITY_CELLS,results).then(function(data){
                        logger.log("promise resolved? = "+data + "-cellid="+results);
                        if(data){
                            logger.log("is-member of city_cells = "+data+" ? - cellid="+item.pos());
                            cb(item.pos());
                        }
                    });
                });
            });
            });
        }


    provider.changeCellPosition = function(newDriverPos,vehicle_id,timestamp,cb){
        //first remove vehicle from cell its exiting
        //then add vehicle to cell its entering. Use redis transactions for this
        var new_cell = s2common.getParentIdAtLevel(12,newDriverPos);
        logger.log("vehicle_id = "+vehicle_id +"> enters grid = " + new_cell + "/"+newDriverPos);
        provider.getVehicleCell(vehicle_id,function(old_cell){
            logger.log("got cell for vehiclekey? = " + old_cell + "=vehicle_id :"+vehicle_id+"}");
            client.multi()
                .zrem(CELL_KEY + old_cell, vehicle_id)
                .zadd(CELL_KEY + new_cell, timestamp, vehicle_id)
                .exec().then(function (results) {
                cb(results);
            });
        });
    }

    /**
     * When vehicle exits a cell, we remove/delete vehicle_id from CELL_KEY
     * @param driverKey
     * @param vehicle_id
     * @param timestamp
     */
    provider.leaveCityCell = function(driverKey,vehicle_id,cb){
        provider.getCellforVehicleKey(driverKey,vehicle_id,function(grid_cell) {
            client.zrem(CELL_KEY +grid_cell,vehicle_id).then(function(results){
                cb(results);
            });
        });
    }
    /**
     * Create unique parent cell id each time a driver is created under
     * driver_cell set. No duplicate cell ids
     * @param cell_id
     */
    provider.createCellPosition = function(cell_id){
        var s2cell = new s2.S2CellId(cell_id);
        if(s2cell.level() < 19){
            client.sadd(CITY_CELLS,cell_id);
        }
    }

    /**
     * getCityGrid returns a list of all S2 cells at level 12-14 that makes up
     * city boundary under default constraints (min=12, max = 14, max_cells = 1000)
     * currently retrieves around 960 cells between level 12-14 when given a centre point
     * with a radius (meters) configured in config/init.js as {radius: '32000'}
     * @returns {*}
     */
    provider.getCityGrid = function(cb){
        client.smembers(CITY_CELLS).then(function(results){
            cb(results);
        });
    }

    /**
     * REDO----
     * retrieve parent_ids from the driver_cell set
     * @param driver_id
     */
    provider.getDriverPositions = function(driver_key,cb){
        //driver_cells - we retrieve driver quadKeys from VEHICLE_KEY
        logger.log(driver_key);
        client.zrange(VEHICLE_KEY+driver_key,0,-1,'withscores').then(function(celldata){
            logger.log("driver = " + driver_key + ", positions = " + JSON.stringify(celldata));
            cb(celldata);
        }).catch(function(error){
            var err_msg = "error retrieving position for driver id = ";
            cb(err_msg + driver_key);
        });
    }

    /**
     * Retrieve all drivers that are in a given cell
     * @param s2cell_id
     */
    provider.getDriversInCell = function(s2cell_id,cb){
        if(new s2.S2CellId(s2cell_id).isLeaf()){
            cb(null);
        }
        else {
            client.zrange(CELL_KEY + s2cell_id,0,-1,'withscores').then(function (results) {
                if (results.length > 0) {
                    var array = _.toArray(results);
                    cb(array);
                }
                else {
                    logger.log("no members " + results);
                    cb(null);
                }
            }).catch(function(error){
                logger.log('error = '+error);
            });;
        }
    }

    /**
     * retrieve keys from driver hashset
     * @type {Array}
     */
    provider.keys = function(cb){
        client.keys(driver_hashset, function (err, data) {
            console.log("logging keys ->" + data);
            cb(data);
        });
    }

    return provider;

}).call(this);
exports.provider = provider;

//2203795067297071104
//2203793418029629440


/*var vehicle_id59 = "004461";
var ts = new Date().getTime();
provider.changeCellPosition("2203840188725229341",vehicle_id59,ts,function(results){
    logger.log(results);
});*/

/*provider.getVehicleCell(vehicle_id59,function(results){
    logger.log("current pos = " + results);
});*/

/*
provider.getCellforVehicleKey("2203795001640038161","004469",function(cell){
 logger.log("-get cell id for vehicle  = " + cell);
 });*/

/*var vehicle_id59 = "004460";
 provider.leaveCityCell("2203795001640038161",vehicle_id59,function(response){
 logger.log("removing vehicle id = " + vehicle_id59 + "-"+response);
 })*/

//provider.addDriverPosition("2203795003930470261");

var ts = new Date().getTime();
try{
    var vehiclekey = "2203840532358176487";
    var vehicle2   = "2203803946975095603";
    var vehicle3   = "2203792415811550533";
    var vehicle4   = "2203806913340145105";

    var vehicleId = "004458";

    //provider.addVehiclePosition(vehiclekey,"004473",ts);
    provider.addVehiclePosition(vehicle2,"004474",ts+80);
    /*provider.addVehiclePosition(vehicle3,"004475",ts+120);
    provider.addVehiclePosition(vehicle4,"004476",ts+150);*/

    /*provider.getVehiclePosition(vehicle2,function(results){
        logger.log(">>> positions for vehicle_id = " + vehicle2 + " [total pos = "+results.length);
        results.forEach(function(item){
            logger.log("vehicle_id:" + vehicle2 + " - [" + item +"]");
        });
    });
    logger.log("adding to cell id = -------" + vehicle2 +
        "=["+s2common.getParentIdAtLevel(12,vehicle2)+"]------");*/

}catch(error){
    logger.log(error);
}
/*

 //14900 - 9800 (at 9:02 pm)
 provider.getVehiclePositionByTime(vehicleId,14900,function(results){
 logger.log(results);
 });

var driver_id2 = "004471";
provider.getDriverPositions(driver_id2,function(results){
    logger.log("position of "+ driver_id2 + ", positions = " + results);
})

var grid_key = "2203795067297071104";
var grid_key2 = "2203794861138657280";
provider.getDriversInCell(grid_key,function(data){
    logger.log("drivers within grid cell = " +grid_key+"-"+ JSON.stringify(data));
})*/