module.exports = GCanvas;

var Path = require('./path')
  , Motion = require('./motion')
  , GCodeDriver = require('./drivers/gcode')
  , Point = require('./math/point')
  , Matrix = require('./math/matrix')
  , parseFont = require('./parsefont')
  , ClipperLib = require('./clipper')
  , FontUtils = require('./FontUtils')
  , utils = require('./utils');

function GCanvas(driver, width, height) {
  this.canvas = {
    width: width,
    height: height
  };

  this.font = "7pt Helvetiker";
  this.matrix = new Matrix();
  this.rotation = 0; 
  this.depth = 1;
  this.depthOfCut = 0.25;
  this.toolDiameter = 5;
  this.fillStrategy = 'crosshatch';
  this.driver = driver || new GCodeDriver();
  this.position = new Point(0,0,0);
  this.stack = [];
  this.motion = new Motion(this);

  this.beginPath();
}

GCanvas.prototype = {
  save: function() {
    this.stack.push({
      matrix: this.matrix.clone(),
      rotation: this.rotation
    });
  }
, restore: function() {
    var prev = this.stack.pop();
    if(!prev) return;
    this.matrix = prev.matrix;
    this.rotation = prev.rotation;
  }
, beginPath: function() {
    this.path = new Path();
    this.subPaths = [this.path];
  }
, rotate: function(angle) {
    this.matrix = this.matrix.rotate(angle);
  }
, translate: function(x,y) {
    this.matrix = this.matrix.translate(x,y);
  }
, scale: function(x,y) {
    this.matrix = this.matrix.scale(x,y);
  }
  // TODO: clean up
, _transformPoint: function(a, i) {
    i = i || 0;
    if(a.length) {
      var v = new Point(a[i], a[i+1]);
      v = this.matrix.transformPoint(v);
      a[i] = v.x; 
      a[i+1] = v.y; 
    }
    else if(a.x) {
      var v = new Point(a.x, a.y);
      v = this.matrix.transformPoint(v);
      a.x = v.x; 
      a.y = v.y; 
    }
  }
, _ensurePath: function(x,y) {
    if(this.path.actions.length === 0) {
      this.path.moveTo(x,y);
    }
  }
, moveTo: function(x,y) {
    this._transformPoint(arguments);
    this.path = new Path();
    this.path.moveTo(x,y);
    this.subPaths.push( this.path );
  }
, lineTo: function(x,y) {
    this._transformPoint(arguments);
    this._ensurePath(x,y);
    this.path.lineTo(x,y);
  }
, arc: function (x, y, radius,
									  aStartAngle,
                    aEndAngle,
                    aClockwise ) {
    // In the conversion to points we lose the distinction
    // between 0 and pi2 so we must optimize out 0 here 
    // or else they will be treated as full circles.
    if(aStartAngle - aEndAngle === 0) {
      this.lineTo();
      return;
    }

    // See portal2 example
    if(aEndAngle-aStartAngle === -Math.PI*2)
      aEndAngle = Math.PI*2;

    var center = new Point(x, y, 0);
    var points = utils.arcToPoints(center,
                                   aStartAngle,
                                   aEndAngle,
                                   radius);
    // center.applyMatrix(this.matrix);
    this._transformPoint(center);
    this._transformPoint(points.start);
    this._transformPoint(points.end);

    var res = utils.pointsToArc(center,
                                points.start,
                                points.end);

    this._ensurePath(points.start.x, points.start.y);
    this.path.arc(center.x, center.y, res.radius, res.start, res.end, aClockwise);
  }
, bezierCurveTo: function( aCP1x, aCP1y,
                           aCP2x, aCP2y,
                           aX, aY ) {

    this._transformPoint(arguments, 0);
    this._transformPoint(arguments, 2);
    this._transformPoint(arguments, 4);

    this.path.bezierCurveTo.apply(this.path, arguments);
  }

, quadraticCurveTo: function( aCPx, aCPy, aX, aY ) {
    this._transformPoint(arguments, 0);
    this._transformPoint(arguments, 2);

    this.path.quadraticCurveTo.apply(this.path, arguments);
  }

, _offsetStroke: function(delta) {
    var cpr = new ClipperLib.Clipper();
    var polygons = [];
    this.subPaths.forEach(function(path) {
      if(path.actions.length !== 0)
        polygons.push( path.getPoints(40).map(function(p) {
          return {X: p.x, Y: p.y};
        }) );
    });

    function path2poly(path) {
      var poly = [];
      if(path.actions.length !== 0)
        poly.push( path.getPoints(40).map(function(p) {
          return {X: p.x, Y: p.y};
        }) );
        return poly;
    }


    polygons = ClipperLib.Clean(polygons, cleandelta * scale);

    if(this.clipRegion) {
      var cpr = new ClipperLib.Clipper();
      var subject_fillType = 0;
      var clip_fillType = 1;
      var clip_polygons = path2poly(this.clipRegion);
      // var clipType = ClipperLib.ClipType.ctIntersection;
      var clipType = 0;
      cpr.AddPolygons(polygons, ClipperLib.PolyType.ptSubject);
      cpr.AddPolygons(clip_polygons, ClipperLib.PolyType.ptClip);
      var result = [];
      var succeeded = cpr.Execute(clipType, result, subject_fillType, clip_fillType);
      polygons = result;
    }

    scaleup(polygons, 1000);

    delta *= 1000;

    var scale = 1;
    var cleandelta = 0.1; // 0.1 should be the appropriate delta in different cases

    polygons = cpr.SimplifyPolygons(polygons, ClipperLib.PolyFillType.pftNonZero);
    // polygons = ClipperLib.Clean(polygons, cleandelta * scale);

    cpr.AddPolygons(polygons, ClipperLib.PolyType.ptSubject);

    var joinType = ClipperLib.JoinType.jtSquare;
    var miterLimit = 1;
    var AutoFix = true;

    var offsetted_polygon = cpr.OffsetPolygons(polygons, delta, joinType, miterLimit, AutoFix);


    scaleup(offsetted_polygon, 1/1000);

    function scaleup(poly, scale) {
      var i, j;
      if (!scale) scale = 1;
      for(i = 0; i < poly.length; i++) {
        for(j = 0; j < poly[i].length; j++) {
          poly[i][j].X *= scale;
          poly[i][j].Y *= scale;
        }
      }
      return poly;
    }

    // converts polygons to SVG path string
    function polys2path (poly, scale) {
      var path = new Path(), i, j;
      if (!scale) scale = 1;
      for(i = 0; i < poly.length; i++) {
        path.moveTo(poly[i][0].X, poly[i][0].Y);

        for(j = 1; j < poly[i].length; j++){
          path.lineTo(poly[i][j].X, poly[i][j].Y);
        }

        path.lineTo(poly[i][0].X, poly[i][0].Y);
      }
      // console.log(path);
      return path;
    }

    // console.log(offsetted_polygon);

    if(offsetted_polygon.length === 0
      || offsetted_polygon[0].length === 0) return true;

    this._strokePath(polys2path(offsetted_polygon));
  }
, clip: function() {
    this.clipRegion = this.path;
  }
, fill: function() {
    for(var i = - this.toolDiameter/2; i > -1000; i -= this.toolDiameter) {
      var done = this._offsetStroke(i);
      if(done) return;
    }
  }
, rect: function(x,y,w,h) { 
    this.moveTo(x,y);
    this.lineTo(x+w,y);
    this.lineTo(x+w,y+h);
    this.lineTo(x,y+h);
    this.lineTo(x,y);
  }
, fillRect: function(x,y,w,h) { 
    this.beginPath();
    this.rect.apply(this, arguments);
    this.fill();
  }
, measureText: function(text) {
    var width=0, height=0;
    var paths = FontUtils.drawText(text).paths;
    paths.forEach(function(path) {
      var box = path.getBoundingBox();
      width += box.maxX;
      height = Math.max(height, box.maxY);
    });

    return {width: width, height: height};
  }
, stroke: function() {
    this.layers(function() {
      this.subPaths.forEach(this._strokePath, this);
    });

  }
, _strokePath: function(path) {
    var each = {};
    var motion = this.motion;
    var driver = this.driver;
    var item;

    each[Path.actions.MOVE_TO] = function(x,y) {
      motion.retract();
      motion.rapid({x:x,y:y});
    };

    each[Path.actions.LINE_TO] = function(x,y) {
      motion.plunge();
      motion.linear({x:x,y:y});
    };

    // 3js just converts a bunch of stuff to absellipse
    // but for our purposes this weird lossiness works
    // fine since we should detect ellipses that are arcs
    // and optimizing by using the native methods anyway.
    each[Path.actions.ELLIPSE] = function(x, y, rx, ry,
									  aStart, aEnd, aClockwise , mx, my) {
      motion.plunge();

      // Detect plain arc
      if(utils.sameFloat(rx,ry) &&
        (driver.arcCW && !aClockwise) ||
        (driver.arcCCW && aClockwise) ) {
          var center = new Point(x, y);
          var points = utils.arcToPoints(center,
                                         aStart,
                                         aEnd,
                                         rx);
          var params = {
            x: points.end.x, y: points.end.y,
            i: x, j: y
          };

          if(aClockwise)
            motion.arcCCW(params);
          else
            motion.arcCW(params);
      }
      else {
        this._interpolate('ellipse', arguments, i === 0);
      }
    };

    each[Path.actions.BEZIER_CURVE_TO] = function() {
      this._interpolate('bezierCurveTo', arguments);
    };

    each[Path.actions.QUADRATIC_CURVE_TO] = function() {
      this._interpolate('quadraticCurveTo', arguments);
    };

    for(var i = 0, l = path.actions.length; i < l; ++i) {
      item = path.actions[i]
      each[item.action].apply(this, item.args);
    }

  }
, layers: function(fn) {
     // this.motion.linear({z: this.position.z + this.depthOfCut});
     // while(this.position.z < this.depth) {
     //   this.motion.linear({z: this.position.z + this.depthOfCut});
     // }
     fn.call(this);
  }
, fillText: function(text, x, y, params) {
    this.layers(function() {
      this.beginPath();
      var fontProps = parseFont(this.font);
      FontUtils.weight = fontProps.weight;
      FontUtils.style = fontProps.style;
      FontUtils.size = fontProps.size;
      FontUtils.face = FontUtils.faces[fontProps.family] ? fontProps.family : 'helvetiker';

      var paths = FontUtils.drawText(text).paths;

      this.save();
      this.translate(x, y);

      paths.forEach(function(path,i) {
        path.actions.forEach(function(action) {
          this[action.action].apply(this, action.args);
        }, this);
      }, this);
      this.fill();

      this.restore();
    });
  }

, strokeText: function(text, x, y, params) {
    this.layers(function() {

      var fontProps = parseFont(this.font);
      FontUtils.weight = fontProps.weight;
      FontUtils.style = fontProps.style;
      FontUtils.size = fontProps.size;
      FontUtils.face = FontUtils.faces[fontProps.family] ? fontProps.family : 'helvetiker';

      var paths = FontUtils.drawText(text).paths;

      this.save();
      this.translate(x, y);

      paths.forEach(function(path,i) {
        path.actions.forEach(function(action) {
          this[action.action].apply(this, action.args);
        }, this);
      }, this);

      this.stroke();
      this.restore();
    });
  }

/**
 *   
 * */
, _interpolate: function(name, args, moveToFirst) {
    var path = new Path([this.position]);
    path[name].apply(path, args);

    var pts = path.getPoints(40);
    for(var i=0,l=pts.length; i < l; ++i) {
      var p=pts[i];
      this._ensurePath(p);
      if(i === 0 && moveToFirst)
        this.motion.rapid({x:p.x, y:p.y});
      else
        this.motion.linear({x:p.x, y:p.y});
    };

    // close it
    // this.motion.linear({x:p.x, y:p.y});
  }
};

GCanvas.Filter = require('./drivers/filter');
GCanvas.Simulator = require('./drivers/simulator');

// TODO: Real ttf font loading (UGH!)
var helvetiker = require('./fonts/helvetiker_regular.typeface');
FontUtils.loadFace(helvetiker);
