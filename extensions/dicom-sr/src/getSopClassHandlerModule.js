import id from './id';
import { utils, classes } from '@ohif/core';
import addMeasurement from './utils/addMeasurement.js';

const { ImageSet } = classes;

const sopClassHandlerName = 'dicom-sr';

// TODO ->
// Add SR thumbnail
// Make viewport
// Get stacks from referenced displayInstanceUID and load into wrapped CornerStone viewport.

const sopClassUids = [
  '1.2.840.10008.5.1.4.1.1.88.11', //BASIC_TEXT_SR:
  '1.2.840.10008.5.1.4.1.1.88.22', //ENHANCED_SR:
  '1.2.840.10008.5.1.4.1.1.88.33', //COMPREHENSIVE_SR:
];

const CodeNameCodeSequenceValues = {
  ImagingMeasurementReport: '126000',
  ImageLibrary: '111028',
  ImagingMeasurements: '126010',
  MeasurementGroup: '125007',
  ImageLibraryGroup: '126200',
  TrackingUniqueIdentifier: '112040',
};

const RELATIONSHIP_TYPE = {
  INFERRED_FROM: 'INFERRED FROM',
};

/**
 * Basic SOPClassHandler:
 * - For all Image types that are stackable, create
 *   a displaySet with a stack of images
 *
 * @param {Array} sopClassHandlerModules List of SOP Class Modules
 * @param {SeriesMetadata} series The series metadata object from which the display sets will be created
 * @returns {Array} The list of display sets created for the given series object
 */
function _getDisplaySetsFromSeries(
  instances,
  servicesManager,
  extensionManager
) {
  // If the series has no instances, stop here
  if (!instances || !instances.length) {
    throw new Error('No instances were provided');
  }

  const { DisplaySetService } = servicesManager.services;
  const dataSources = extensionManager.getDataSources();
  const dataSource = dataSources[0];

  const instance = instances[0];

  const {
    StudyInstanceUID,
    SeriesInstanceUID,
    SOPInstanceUID,
    SeriesDescription,
    SeriesNumber,
    SeriesDate,
  } = instance;
  const { ConceptNameCodeSequence, ContentSequence } = instance;

  if (
    ConceptNameCodeSequence.CodeValue !==
    CodeNameCodeSequenceValues.ImagingMeasurementReport
  ) {
    console.warn(
      'Only support Imaging Measurement Report SRs (TID1500) for now'
    );
    return [];
  }

  const displaySet = {
    plugin: id,
    Modality: 'SR',
    displaySetInstanceUID: utils.guid(),
    SeriesDescription,
    SeriesNumber,
    SeriesDate,
    SOPInstanceUID,
    SeriesInstanceUID,
    StudyInstanceUID,
    SOPClassHandlerId: `${id}.sopClassHandlerModule.${sopClassHandlerName}`,
    referencedImages: _getReferencedImagesList(ContentSequence),
    measurements: _getMeasurements(ContentSequence),
    sopClassUids,
  };

  // Check currently added displaySets and add measurements if the sources exist.
  DisplaySetService.activeDisplaySets.forEach(activeDisplaySet => {
    _checkIfCanAddMeasurementsToDisplaySet(
      displaySet,
      activeDisplaySet,
      dataSource
    );
  });

  // Subscribe to new displaySets as the source may come in after.
  DisplaySetService.subscribe(
    DisplaySetService.EVENTS.DISPLAY_SETS_ADDED,
    data => {
      const { displaySetsAdded } = data;
      // If there are still some measurements that have not yet been loaded into cornerstone,
      // See if we can load them onto any of the new displaySets.
      displaySetsAdded.forEach(newDisplaySet => {
        _checkIfCanAddMeasurementsToDisplaySet(
          displaySet,
          newDisplaySet,
          dataSource
        );
      });
    }
  );

  return [displaySet];
}

function _checkIfCanAddMeasurementsToDisplaySet(
  srDisplaySet,
  newDisplaySet,
  dataSource
) {
  let unloadedMeasurements = srDisplaySet.measurements.filter(
    measurement => measurement.loaded === false
  );

  if (unloadedMeasurements.length === 0) {
    // All already loaded!
    return;
  }

  if (!newDisplaySet instanceof ImageSet) {
    // This also filters out _this_ displaySet, as it is not an ImageSet.
    return;
  }

  const { sopClassUids, images } = newDisplaySet;

  // Check if any have the newDisplaySet is the correct SOPClass.
  unloadedMeasurements = unloadedMeasurements.filter(measurement =>
    measurement.coords.some(coord =>
      sopClassUids.includes(coord.ReferencedSOPSequence.ReferencedSOPClassUID)
    )
  );

  if (unloadedMeasurements.length === 0) {
    // New displaySet isn't the correct SOPClass, so can't contain the referenced images.
    return;
  }

  const SOPInstanceUIDs = [];

  unloadedMeasurements.forEach(measurement => {
    const { coords } = measurement;

    coords.forEach(coord => {
      const SOPInstanceUID =
        coord.ReferencedSOPSequence.ReferencedSOPInstanceUID;

      if (!SOPInstanceUIDs.includes(SOPInstanceUID)) {
        SOPInstanceUIDs.push(SOPInstanceUID);
      }
    });
  });

  const imageIdsForDisplaySet = dataSource.getImageIdsForDisplaySet(
    newDisplaySet
  );

  for (let i = 0; i < images.length; i++) {
    if (!unloadedMeasurements.length) {
      // All measurements loaded.
      break;
    }

    const image = images[i];
    const { SOPInstanceUID } = image;
    if (SOPInstanceUIDs.includes(SOPInstanceUID)) {
      const imageId = imageIdsForDisplaySet[i];

      for (let j = unloadedMeasurements.length - 1; j >= 0; j--) {
        const measurement = unloadedMeasurements[j];
        if (_measurmentReferencesSOPInstanceUID(measurement, SOPInstanceUID)) {
          addMeasurement(
            measurement,
            imageId,
            newDisplaySet.displaySetInstanceUID
          );

          unloadedMeasurements.splice(j, 1);
        }
      }
    }
  }
}

function _measurmentReferencesSOPInstanceUID(measurement, SOPInstanceUID) {
  const { coords } = measurement;

  for (let j = 0; j < coords.length; j++) {
    const coord = coords[j];
    const { ReferencedSOPInstanceUID } = coord.ReferencedSOPSequence;

    if (ReferencedSOPInstanceUID === SOPInstanceUID) {
      return true;
    }
  }
}

function getSopClassHandlerModule({ servicesManager, extensionManager }) {
  const getDisplaySetsFromSeries = instances => {
    return _getDisplaySetsFromSeries(
      instances,
      servicesManager,
      extensionManager
    );
  };

  return [
    {
      name: sopClassHandlerName,
      sopClassUids,
      getDisplaySetsFromSeries,
    },
  ];
}

function _getMeasurements(ImagingMeasurementReportContentSequence) {
  const ImagingMeasurements = ImagingMeasurementReportContentSequence.find(
    item =>
      item.ConceptNameCodeSequence.CodeValue ===
      CodeNameCodeSequenceValues.ImagingMeasurements
  );

  const MeasurementGroups = _getSequenceAsArray(
    ImagingMeasurements.ContentSequence
  ).filter(
    item =>
      item.ConceptNameCodeSequence.CodeValue ===
      CodeNameCodeSequenceValues.MeasurementGroup
  );

  const mergedContentSequencesByTrackingUniqueIdentifiers = _getMergedContentSequencesByTrackingUniqueIdentifiers(
    MeasurementGroups
  );

  let measurements = [];

  Object.keys(mergedContentSequencesByTrackingUniqueIdentifiers).forEach(
    trackingUniqueIdentifier => {
      const mergedContentSequence =
        mergedContentSequencesByTrackingUniqueIdentifiers[
          trackingUniqueIdentifier
        ];

      const measurement = _processMeasurement(mergedContentSequence);

      if (measurement) {
        measurements.push(measurement);
      }
    }
  );

  return measurements;
}

function _getMergedContentSequencesByTrackingUniqueIdentifiers(
  MeasurementGroups
) {
  const mergedContentSequencesByTrackingUniqueIdentifiers = {};

  MeasurementGroups.forEach(MeasurementGroup => {
    const ContentSequence = _getSequenceAsArray(
      MeasurementGroup.ContentSequence
    );

    const TrackingUniqueIdentifierItem = ContentSequence.find(
      item =>
        item.ConceptNameCodeSequence.CodeValue ===
        CodeNameCodeSequenceValues.TrackingUniqueIdentifier
    );

    if (!TrackingUniqueIdentifierItem) {
      console.warn(
        'No Tracking Unique Identifier, skipping ambiguous measurement.'
      );
    }

    const trackingUniqueIdentifier = TrackingUniqueIdentifierItem.UID;

    if (
      mergedContentSequencesByTrackingUniqueIdentifiers[
        trackingUniqueIdentifier
      ] === undefined
    ) {
      // Add the full ContentSequence
      mergedContentSequencesByTrackingUniqueIdentifiers[
        trackingUniqueIdentifier
      ] = [...ContentSequence];
    } else {
      // Add the ContentSequence minus the tracking identifier, as we have this
      // Information in the merged ContentSequence anyway.
      ContentSequence.forEach(item => {
        if (
          item.ConceptNameCodeSequence.CodeValue !==
          CodeNameCodeSequenceValues.TrackingUniqueIdentifier
        ) {
          mergedContentSequencesByTrackingUniqueIdentifiers[
            trackingUniqueIdentifier
          ].push(item);
        }
      });
    }
  });

  return mergedContentSequencesByTrackingUniqueIdentifiers;
}

function _processMeasurement(mergedContentSequence) {
  if (
    mergedContentSequence.some(
      group => group.ValueType === 'SCOORD' || group.ValueType === 'SCOORD3D'
    )
  ) {
    return _processTID1410Measurement(mergedContentSequence);
  }

  return _processNonGeometricallyDefinedMeasurement(mergedContentSequence);
}

function _processTID1410Measurement(mergedContentSequence) {
  // Need to deal with TID 1410 style measurements, which will have a SCOORD or SCOORD3D at the top level,
  // And non-geometric representations where each NUM has "INFERRED FROM" SCOORD/SCOORD3D
  // TODO -> Look at RelationshipType => Contains means

  const graphicItem = mergedContentSequence.find(
    group => group.ValueType === 'SCOORD'
  );

  const UIDREFContentItem = mergedContentSequence.find(
    group => group.ValueType === 'UIDREF'
  );

  if (!graphicItem) {
    console.warn(
      `graphic ValueType ${graphicItem.ValueType} not currently supported, skipping annotation.`
    );
    return;
  }

  const NUMContentItems = mergedContentSequence.filter(
    group => group.ValueType === 'NUM'
  );

  const measurement = {
    loaded: false,
    labels: [],
    coords: [_getCoordsFromSCOORDOrSCOORD3D(graphicItem)],
    TrackingUniqueIdentifier: UIDREFContentItem.UID,
  };

  NUMContentItems.forEach(item => {
    const { ConceptNameCodeSequence, MeasuredValueSequence } = item;

    if (MeasuredValueSequence) {
      measurement.labels.push(
        _getLabelFromMeasuredValueSequence(
          ConceptNameCodeSequence,
          MeasuredValueSequence
        )
      );
    }
  });

  return measurement;
}

function _processNonGeometricallyDefinedMeasurement(mergedContentSequence) {
  const NUMContentItems = mergedContentSequence.filter(
    group => group.ValueType === 'NUM'
  );

  const UIDREFContentItem = mergedContentSequence.find(
    group => group.ValueType === 'UIDREF'
  );

  const measurement = {
    loaded: false,
    labels: [],
    coords: [],
    TrackingUniqueIdentifier: UIDREFContentItem.UID,
  };

  NUMContentItems.forEach(item => {
    const {
      ConceptNameCodeSequence,
      ContentSequence,
      MeasuredValueSequence,
    } = item;

    const { ValueType } = ContentSequence;

    if (!ValueType === 'SCOORD') {
      console.warn(
        `Graphic ${ValueType} not currently supported, skipping annotation.`
      );

      return;
    }

    const coords = _getCoordsFromSCOORDOrSCOORD3D(ContentSequence);

    if (coords) {
      measurement.coords.push(coords);
    }

    if (MeasuredValueSequence) {
      measurement.labels.push(
        _getLabelFromMeasuredValueSequence(
          ConceptNameCodeSequence,
          MeasuredValueSequence
        )
      );
    }
  });

  return measurement;
}

function _getCoordsFromSCOORDOrSCOORD3D(item) {
  const { ValueType, RelationshipType, GraphicType, GraphicData } = item;

  if (RelationshipType !== RELATIONSHIP_TYPE.INFERRED_FROM) {
    console.warn(
      `Relationshiptype === ${RelationshipType}. Cannot deal with NON TID-1400 SCOORD group with RelationshipType !== "INFERRED FROM."`
    );

    return;
  }

  const coords = { ValueType, GraphicType, GraphicData };

  // ContentSequence has length of 1 as RelationshipType === 'INFERRED FROM'
  if (ValueType === 'SCOORD') {
    const { ReferencedSOPSequence } = item.ContentSequence;

    coords.ReferencedSOPSequence = ReferencedSOPSequence;
  } else if (ValueType === 'SCOORD3D') {
    const { ReferencedFrameOfReferenceSequence } = item.ContentSequence;

    coords.ReferencedFrameOfReferenceSequence = ReferencedFrameOfReferenceSequence;
  }

  return coords;
}

function _getLabelFromMeasuredValueSequence(
  ConceptNameCodeSequence,
  MeasuredValueSequence
) {
  const { CodeMeaning } = ConceptNameCodeSequence;
  const { NumericValue, MeasurementUnitsCodeSequence } = MeasuredValueSequence;
  const { CodeValue } = MeasurementUnitsCodeSequence;

  return { label: CodeMeaning, value: `${NumericValue} ${CodeValue}` }; // E.g. Long Axis: 31.0 mm
}

function _getReferencedImagesList(ImagingMeasurementReportContentSequence) {
  const ImageLibrary = ImagingMeasurementReportContentSequence.find(
    item =>
      item.ConceptNameCodeSequence.CodeValue ===
      CodeNameCodeSequenceValues.ImageLibrary
  );

  const ImageLibraryGroup = _getSequenceAsArray(
    ImageLibrary.ContentSequence
  ).find(
    item =>
      item.ConceptNameCodeSequence.CodeValue ===
      CodeNameCodeSequenceValues.ImageLibraryGroup
  );

  const referencedImages = [];

  _getSequenceAsArray(ImageLibraryGroup.ContentSequence).forEach(item => {
    const { ReferencedSOPSequence } = item;
    const {
      ReferencedSOPClassUID,
      ReferencedSOPInstanceUID,
    } = ReferencedSOPSequence;

    referencedImages.push({ ReferencedSOPClassUID, ReferencedSOPInstanceUID });
  });

  return referencedImages;
}

function _getSequenceAsArray(sequence) {
  return Array.isArray(sequence) ? sequence : [sequence];
}

export default getSopClassHandlerModule;
