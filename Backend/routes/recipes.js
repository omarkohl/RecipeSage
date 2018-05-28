var express = require('express');
var router = express.Router();
var cors = require('cors');
var xmljs = require("xml-js");

// DB
var mongoose = require('mongoose');
var User = mongoose.model('User');
var Recipe = mongoose.model('Recipe');
var Label = mongoose.model('Label');

// Service
var MiddlewareService = require('../services/middleware');
var UtilService = require('../services/util');

//Create a new recipe
router.post(
  '/',
  cors(),
  MiddlewareService.validateSession(['user']),
  MiddlewareService.validateUser,
  UtilService.upload.single('image'),
  function(req, res, next) {
  
  var folder = 'main'; // Default folder
  if (req.body.destinationUserEmail) { //We're sending the recipe to someone else
    folder = 'inbox';
  }

  // Check for title
  if (!req.body.title || req.body.title.length === 0) {
    // This request is bad due to no title, but we already uploaded an image for it. Delete the image before erroring out
    if (req.file && req.file.key) {
      UtilService.deleteS3Object(req.file.key, function() {
        console.log("Cleaned s3 image after precondition failure");
        res.status(412).send("Recipe title must be provided.");
      }, function() {
        console.log("Failed to clean s3 image after precondition failure!");
        res.status(500).send("Original error: 412 - recipe title must be provided. While processing, there was another error: could not delete uploaded image from S3!");
      });
    } else {
      res.status(412).send("Recipe title must be provided.");
    }
  } else {
    // Support for imageURLs instead of image files
    var uploadByURLPromise = new Promise(function(resolve, reject) {
      if (req.body.imageURL) {
        UtilService.sendURLToS3(req.body.imageURL, function(err, img) {
          if (err) {
            reject(err);
          } else {
            resolve(img);
          }
        });
      } else {
        resolve(null);
      }  
    });
    
    uploadByURLPromise.then(function(img) {
      var uploadedFile = img || req.file;
      
      UtilService.findTitle(res.locals.session.accountId, null, req.body.title, 1, function(adjustedTitle) {
        new Recipe({
          accountId: res.locals.session.accountId,
      		title: adjustedTitle,
          description: req.body.description,
          yield: req.body.yield,
          activeTime: req.body.activeTime,
          totalTime: req.body.totalTime,
          source: req.body.source,
          url: req.body.url,
          notes: req.body.notes,
          ingredients: req.body.ingredients,
          instructions: req.body.instructions,
          image: uploadedFile,
          folder: folder
        }).save(function(err, recipe) {
          if (err) {
            res.status(500).send("Error saving the recipe!");
          } else {
            var serializedRecipe = recipe.toObject();
            serializedRecipe.labels = [];
            res.status(201).json(serializedRecipe);
          }
        });
      }, function(err) {
        res.status(500).send("Could not avoid duplicate title!");
      });
    }, function() {
      res.status(500).send("Error uploading image via URL!");
    });
  }
});

//Get all of a user's recipes
router.get(
  '/',
  cors(),
  MiddlewareService.validateSession(['user']),
  MiddlewareService.validateUser,
  function(req, res, next) {

  Recipe.find({
    accountId: res.locals.session.accountId,
    folder: req.query.folder
  })
  .sort(req.query.sort || 'title')
  .populate('fromUser', 'name email')
  .lean()
  .exec(function(err, recipes) {
    if (err) {
      res.status(500).send("Couldn't search the database for recipes!");
    } else {
      
      var labelPromises = [];
      
      for (var i = 0; i < recipes.length; i++) {
        let recipe = recipes[i];
        
        labelPromises.push(new Promise(function(resolve, reject) {
          Label.find({
            recipes: recipe._id
          }).lean().exec(function(err, labels) {
            if (err) {
              reject(500, "Couldn't search the database for labels!");
            } else {
              recipe.labels = labels;
      
              resolve();
            }
          });
        }));
      }
      
      Promise.all(labelPromises).then(function() {
        if (req.query.labels && req.query.labels.length > 0) {
          var allowableLabels = req.query.labels.split(',');
          recipes = recipes.filter(function(el) {
            return el.labels.some(function(label) {
              return allowableLabels.indexOf(label.title) > -1;
            })
          });
        }

        res.status(200).json(recipes);
      }, function() {
        res.status(500).send("Could not query DB for labels.");
      });
    }
  });
});

router.get(
  '/export',
  cors(),
  MiddlewareService.validateSession(['user']),
  MiddlewareService.validateUser,
  function(req, res) {
  
  Recipe.find({
    accountId: res.locals.accountId
  }).lean().exec(function(err, recipes) {
    
    var labelPromises = [];

    for (var i = 0; i < recipes.length; i++) {
      let recipe = recipes[i];
      
      labelPromises.push(new Promise(function(resolve, reject) {
        Label.find({
          recipes: recipe._id
        }).lean().exec(function(err, labels) {
          if (err) {
            reject(500, "Couldn't search the database for labels!");
          } else {
            if (req.query.format === 'txt') {
              recipe.labels = labels.map(function(el){
                return el.title;
              }).join(',');
            } else {
              recipe.labels = labels;
            }
    
            resolve();
          }
        });
      }));
    }
    
    Promise.all(labelPromises).then(function() {
      var data;
      var mimetype;
  
      switch(req.query.format) {
        case 'json':
          data = JSON.stringify(recipes);
          mimetype = 'application/json';
          break;
        case 'xml':
          data = xmljs.json2xml(recipes, {compact: true, ignoreComment: true, spaces: 4});
          mimetype = 'text/xml';
          break;
        case 'txt':
          data = '';
          
          for (var i = 0; i < recipes.length; i++) {
            let recipe = recipes[i];
            for (var key in recipe) {
              if (recipe.hasOwnProperty(key)) {
                data += key + ': ';
                data += recipe[key] + '\r\n';
              }
              
            }
            data += '\r\n';
          }
          
          res.charset = 'UTF-8';
          mimetype = 'text/plain';
          break;
        default:
          res.status(400).send('Unknown export format. Please send json, xml, or txt.');
          return;
      }
      
      res.setHeader('Content-disposition', 'attachment; filename=recipes-' + Date.now() + '.' + req.query.format);
      res.setHeader('Content-type', mimetype);
      res.write(data, function (err) {
        if (err) {
          console.log("Could not write data response for export task.");
        }
  
        res.end();
      });
    }, function() {
      res.status(500).send("Could not query DB for labels.");
    });
  });
});

//Get a single recipe
router.get(
  '/:recipeId',
  cors(),
  MiddlewareService.validateSession(['user']),
  MiddlewareService.validateUser,
  function(req, res, next) {

  Recipe.findOne({
    accountId: res.locals.session.accountId,
    _id: req.params.recipeId
  })
  .populate('fromUser', 'name email')
  .lean()
  .exec(function(err, recipe) {
    if (err) {
      res.status(500).send("Couldn't search the database for recipe!");
    } else if (!recipe) {
      res.status(404).send("Recipe with that ID not found!");
    } else {
      Label.find({
        recipes: recipe._id
      }).lean().exec(function(err, labels) {
        if (err) {
          res.status(500).send("Could not query DB for labels.");
        } else {
          recipe.labels = labels;
  
          res.status(200).json(recipe);
        }
      });
    }
  });
});

//Update a recipe
router.put(
  '/:id',
  cors(),
  MiddlewareService.validateSession(['user']),
  MiddlewareService.validateUser,
  UtilService.upload.single('image'),
  function(req, res) {
  
  Recipe.findOne({
    _id: req.params.id,
    accountId: res.locals.session.accountId
  }, function(err, recipe) {
    if (err) {
      res.status(500).json({
        msg: "Couldn't search the database for recipe!"
      });
    } else if (!recipe) {
      res.status(404).json({
        msg: "Recipe with that ID does not exist!"
      });
    } else {
      if (typeof req.body.description === 'string') recipe.description = req.body.description;
      if (typeof req.body.yield === 'string') recipe.yield = req.body.yield;
      if (typeof req.body.activeTime === 'string') recipe.activeTime = req.body.activeTime;
      if (typeof req.body.totalTime === 'string') recipe.totalTime = req.body.totalTime;
      if (typeof req.body.source === 'string') recipe.source = req.body.source;
      if (typeof req.body.url === 'string') recipe.url = req.body.url;
      if (typeof req.body.notes === 'string') recipe.notes = req.body.notes;
      if (typeof req.body.ingredients === 'string') recipe.ingredients = req.body.ingredients;
      if (typeof req.body.instructions === 'string') recipe.instructions = req.body.instructions;
      if (typeof req.body.folder === 'string') recipe.folder = req.body.folder;
      
      // Check if user uploaded a new image. If so, delete the old image to save space and $$
      if (req.file) {
        // Remove old (replaced) image from our S3 bucket
        if (recipe.image && recipe.image.key) {
          UtilService.deleteS3Object(recipe.image.key, function() {
            console.log("Cleaned old image from s3", recipe.image.key);
          }, function(err) {
            console.log("Error cleaning old image from s3 ", err, err.stack);
          });
        }

        recipe.image = req.file;
      }

      recipe.updated = Date.now();

      UtilService.findTitle(res.locals.session.accountId, recipe._id, req.body.title || recipe.title, 1, function(adjustedTitle) {
        recipe.title = adjustedTitle;

        recipe.save(function(err, recipe) {
          if (err) {
            res.status(500).send("Could not save updated recipe!");
          } else {
            res.status(200).json(recipe);
          }
        });
      }, function(err) {
        res.status(500).send("Could avoid duplicate title!");
      });
    }
  });
});

router.delete(
  '/:id',
  cors(),
  MiddlewareService.validateSession(['user']),
  MiddlewareService.validateUser,
  function(req, res) {
  
  Recipe.findOne({
    _id: req.params.id,
    accountId: res.locals.session.accountId
  }, function(err, recipe) {
    if (err) {
      res.status(500).send({
        msg: "Couldn't search the database for recipe!"
      });
    } else if (!recipe) {
      res.status(404).json({
        msg: "Recipe with specified ID does not exist!"
      });
    } else {
      recipe.remove(function(err, recipe) {
        if (err) {
          res.status(500).json({
            msg: "Couldn't delete recipe from database"
          });
        } else {
          // Remove image from our S3 bucket
          if (recipe.image && recipe.image.key) {
            UtilService.deleteS3Object(recipe.image.key, function() {
              console.log("Cleaned image from s3 after recipe delete ", recipe.image.key);
            }, function(err) {
              console.log("Error cleaning image from s3 after recipe delete ", err, err.stack);
            });
          }

          Label.find({
            accountId: res.locals.session.accountId,
            recipes: req.params.id
          }).select("_id").lean().exec(function(err, labels) {
            if (err) {
              res.status(500).json({
                msg: "Couldn't search the database for labels!"
              });
            } else if (!labels) {
              res.status(200).json(recipe);
            } else {
              var labelPromises = [];
      
              for (var i = 0; i < labels.length; i++) {
                let label = labels[i];
                
                labelPromises.push(new Promise(function(resolve, reject) {
                  Label.findByIdAndUpdate(
                    label._id, {
                      $pull: {
                        recipes: recipe._id
                      }
                    }, {
                      new: true
                    }).exec(function(err, label) {
                    if (err) {
                      reject(500, "Couldn't search the database for labels during delete!");
                    } else {
                      if (label.recipes.length == 0) {
                        label.remove(function(err, label) {
                          if (err) {
                            reject("Couldn't delete empty label!");
                          } else {
                            resolve();
                          }
                        });
                      } else {
                        resolve();
                      }
                    }
                  });
                }));
              }
              
              Promise.all(labelPromises).then(function() {
                res.status(200).json(recipe);
              }, function() {
                res.status(500).send("Could not delete labels from DB.");
              });
            }
          });
        }
      });
    }
  });
});


module.exports = router;
