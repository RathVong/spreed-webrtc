/*
 * Spreed WebRTC.
 * Copyright (C) 2013-2014 struktur AG
 *
 * This file is part of Spreed WebRTC.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */
define(['jquery', 'underscore', 'text!partials/presentation.html'], function($, _, template) {

	return ["$window", "mediaStream", "fileUpload", "fileDownload", "alertify", "translation", "randomGen", function($window, mediaStream, fileUpload, fileDownload, alertify, translation, randomGen) {

		var controller = ['$scope', '$element', '$attrs', function($scope, $element, $attrs) {

			var presentationsCount = 0;
			var pane = $element.find(".presentationpane");

			$scope.layout.presentation = false;
			$scope.isPresenter = false;
			$scope.hideControlsBar = false;
			$scope.pendingPageRequest = null;
			$scope.presentationLoaded = false;

			$scope.$on("pdfLoaded", function(event, source, doc) {
				if ($scope.isPresenter) {
					$scope.$emit("showPdfPage", 1);
				} else if ($scope.pendingPageRequest !== null) {
					$scope.$emit("showPdfPage", $scope.pendingPageRequest);
					$scope.pendingPageRequest = null;
				} else {
					$scope.$emit("showQueuedPdfPage");
				}
				$scope.presentationLoaded = true;
			});

			var downloadScope = $scope.$new();
			downloadScope.$on("downloadComplete", function(event) {
				event.stopPropagation();
				finishDownloadPresentation();
			});

			downloadScope.$on("writeComplete", function(event, url, fileInfo) {
				event.stopPropagation();
				if (url.indexOf("blob:") === 0) {
					$scope.$emit("openPdf", url);
				} else {
					fileInfo.file.file(function(fp) {
						$scope.$emit("openPdf", fp);
					});
				}
			});

			var finishDownloadPresentation = function() {
				if (downloadScope.info) {
					mediaStream.tokens.off(downloadScope.info.id, downloadScope.handler);
					downloadScope.info = null;
					downloadScope.handler = null;
				}
			};

			var downloadPresentation = function(fileInfo, from) {
				finishDownloadPresentation();

				var token = fileInfo.id;
				$scope.presentationLoaded = false;
				$scope.pendingPageRequest = null;
				downloadScope.info = fileInfo;
				downloadScope.handler = mediaStream.tokens.on(token, function(event, currenttoken, to, data, type, to2, from, xfer) {
					//console.log("Presentation token request", currenttoken, data, type);
					fileDownload.handleRequest($scope, xfer, data);
				}, "xfer");

				fileDownload.startDownload(downloadScope, from, token);
			};

			var uploadScope = $scope.$new();

			var finishUploadPresentation = function() {
				if (uploadScope.info) {
					uploadScope.$emit("cancelUpload");
					mediaStream.tokens.off(uploadScope.info.id, uploadScope.handler);
					uploadScope.info = null;
					uploadScope.handler = null;
				}
			};

			var uploadPresentation = function(fileInfo) {
				finishUploadPresentation();

				var token = fileInfo.id;
				uploadScope.info = fileInfo;
				var session = fileUpload.startUpload(uploadScope, token);
				// This binds the token to transfer and ui.
				uploadScope.handler = mediaStream.tokens.on(token, function(event, currenttoken, to, data, type, to2, from, xfer) {
					//console.log("Presentation token request", currenttoken, data, type);
					session.handleRequest(uploadScope, xfer, data);
				}, "xfer");
			};

			mediaStream.api.e.on("received.presentation", function(event, id, from, data, p2p) {
				if (!p2p) {
					console.warn("Received presentation info without p2p. This should not happen!");
					return;
				}

				$scope.$emit("mainview", "presentation", true);

				if (data.Type) {
					switch (data.Type) {
					case "FileInfo":
						console.log("Received presentation file request", data);
						downloadPresentation(data.FileInfo, from);
						break;

					case "Page":
						if (!$scope.presentationLoaded) {
							console.log("Queuing presentation page request, not loaded yet", data);
							$scope.pendingPageRequest = data.Page;
						} else {
							console.log("Received presentation page request", data);
							$scope.$emit("showPdfPage", data.Page);
						}
						break;

					default:
						console.log("Received unknown presentation event", data);
					}
				}
			});

			var peers = {};
			var presentations = [];
			var currentToken = null;
			var tokenHandler = null;

			var connector = function(token, peercall) {
				console.log("XXX connector", token, peercall);
				if (peers.hasOwnProperty(peercall.id)) {
					// Already got a connection.
					return;
				}
				peers[peercall.id] = true;
				mediaStream.api.apply("sendPresentation", {
					send: function(type, data) {
						return peercall.peerconnection.send(data);
					}
				})(peercall.from, token);
			};

			// Updater function to bring in new calls.
			var updater = function(event, state, currentcall) {
				console.log("XXX updater", event, state, currentcall);
				switch (state) {
					case "completed":
					case "connected":
						connector(currentToken, currentcall);
						break;
					case "closed":
						delete peers[currentcall.id];
						if (!peers.length) {
							console.log("All peers disconnected, stopping presentation");
							$scope.$apply(function(scope) {
								scope.hidePresentation();
							});
						}
						break;
				}
			};

			$scope.$on("pdfPageLoading", function(event, page) {
				if (!$scope.isPresenter) {
					return;
				}

				_.each(peers, function(ignore, peerId) {
					var peercall = mediaStream.webrtc.findTargetCall(peerId);
					mediaStream.api.apply("sendPresentation", {
						send: function(type, data) {
							return peercall.peerconnection.send(data);
						}
					})(peerId, currentToken, {
						Type: "Page",
						Page: page
					});
				});
			});

			$scope.showPresentation = function() {
				console.log("Presentation active");
				if ($scope.layout.presentation) {
					$scope.hidePresentation();
				}

				$scope.layout.presentation = true;
				$scope.$emit("mainview", "presentation", true);

				if (currentToken) {
					mediaStream.tokens.off(currentToken, tokenHandler);
				}

				// Create token to register with us and send token out to all peers.
				// Peers when connect to us with the token and we answer.
				currentToken = "presentation_" + $scope.id + "_" + (presentationsCount++);

				// Create callbacks are called for each incoming connections.
				tokenHandler = mediaStream.tokens.create(currentToken, function(event, currenttoken, to, data, type, to2, from, peerpresentation) {
					console.log("Presentation create", currenttoken, data, type, peerpresentation);
					presentations.push(peerpresentation);
					//usermedia.addToPeerConnection(peerscreenshare.peerconnection);
				}, "presentation");

				// Connect all current calls.
				mediaStream.webrtc.callForEachCall(function(peercall) {
					connector(currentToken, peercall);
				});
				// Catch later calls too.
				mediaStream.webrtc.e.on("statechange", updater);

				// create drag-drop target
				var namespace = "file_" + $scope.id;
				var binder = fileUpload.bindDrop(namespace, $element, _.bind(function(files) {
					console.log("Files dragged", files);
					if (files.length > 1) {
						alertify.dialog.alert(translation._("Only single PDF documents can be shared at this time."));
						return;
					}

					_.each(files, _.bind(function(f) {
						var info = $.extend({
							id: f.id
						}, f.info);
						if (info.type !== "application/pdf") {
							console.log("Not sharing file", f, info);
							alertify.dialog.alert(translation._("Only PDF documents can be shared at this time."));
							return;
						}
						console.log("Advertising file", f, info);
						// TODO(fancycode): other peers should either request the file or subscribe rendered images (e.g. for mobile app), for now we send the whole file
						_.each(peers, function(ignore, peerId) {
							var peercall = mediaStream.webrtc.findTargetCall(peerId);
							mediaStream.api.apply("sendPresentation", {
								send: function(type, data) {
									return peercall.peerconnection.send(data);
								}
							})(peerId, currentToken, {
								Type: "FileInfo",
								FileInfo: info
							});
						});
						uploadPresentation(info);
						$scope.isPresenter = true;
						$scope.$emit("openPdf", f);
					}, this));
				}, this));
				binder.namespace = function() {
					// Inject own id into namespace.
					return namespace + "_" + $scope.myid;
				};

			};

			$scope.hidePresentation = function() {
				console.log("Presentation disabled");
				$scope.$emit("closePdf");
				finishUploadPresentation();
				finishDownloadPresentation();
				$scope.layout.presentation = false;
				$scope.isPresenter = false;
				$scope.$emit("mainview", "presentation", false);
			};

			$scope.$watch("layout.presentation", function(newval, oldval) {
				if (newval && !oldval) {
					$scope.showPresentation();
				} else if (!newval && oldval) {
					$scope.hidePresentation();
				}
			});

		}];

		return {
			restrict: 'E',
			replace: true,
			scope: true,
			template: template,
			controller: controller
		};

	}];

});
