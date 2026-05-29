import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  FlatList,
  Alert,
  TextInput,
  Linking,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import {
  X,
  Upload,
  FileText,
  ChevronRight,
  CheckCircle2,
  ArrowRight,
  FileSpreadsheet,
  ExternalLink,
} from 'lucide-react-native';
import Colors from '@/constants/colors';
import { fetchSheetCsv, parseCSV as parseCsvShared, extractSpreadsheetId as extractIdShared } from '@/lib/googleSheetsCsv';

export interface ParsedCoach {
  firstName: string;
  lastName: string;
  club: string;
  ageGroup: string;
  division: string;
  teamName: string;
  isCertified: boolean;
}

interface CoachCSVImportModalProps {
  visible: boolean;
  onClose: () => void;
  onImport: (coaches: ParsedCoach[]) => Promise<{ created: number; skipped: number }>;
}

type ImportStep = 'source' | 'select' | 'googleSheets' | 'mapping' | 'preview' | 'importing' | 'complete';
type ImportSource = 'csv' | 'googleSheets';

const REQUIRED_FIELDS = ['firstName', 'lastName'];
const ALL_FIELDS: { key: keyof ParsedCoach | 'certifiedLabel'; label: string; required: boolean }[] = [
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'club', label: 'Club', required: false },
  { key: 'ageGroup', label: 'Age Group', required: false },
  { key: 'division', label: 'Division', required: false },
  { key: 'teamName', label: 'Team Name', required: false },
  { key: 'certifiedLabel', label: 'Certified', required: false },
];

export default function CoachCSVImportModal({
  visible,
  onClose,
  onImport,
}: CoachCSVImportModalProps) {
  const [step, setStep] = useState<ImportStep>('source');
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, number>>({});
  const [parsedCoaches, setParsedCoaches] = useState<ParsedCoach[]>([]);
  const [importResult, setImportResult] = useState<{ created: number; skipped: number } | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  const resetState = useCallback(() => {
    setStep('source');
    setImportSource(null);
    setCsvData([]);
    setHeaders([]);
    setColumnMapping({});
    setParsedCoaches([]);
    setImportResult(null);
    setFileName('');
    setSheetUrl('');
    setIsLoadingSheet(false);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const extractSpreadsheetId = (url: string): string | null => extractIdShared(url);

  const handleSelectSource = (source: ImportSource) => {
    setImportSource(source);
    if (source === 'csv') {
      setStep('select');
    } else {
      setStep('googleSheets');
    }
  };

  const handleFetchGoogleSheet = async () => {
    const extractedId = extractSpreadsheetId(sheetUrl.trim());
    if (!extractedId) {
      Alert.alert('Invalid URL', 'Please enter a valid Google Sheets URL or spreadsheet ID.');
      return;
    }
    setIsLoadingSheet(true);
    try {
      const content = await fetchSheetCsv(extractedId);
      const parsed = parseCsvShared(content);
      if (parsed.length < 2) {
        Alert.alert('Invalid Sheet', 'The spreadsheet must have a header row and at least one data row.');
        setIsLoadingSheet(false);
        return;
      }
      const headerRow = parsed[0];
      const dataRows = parsed.slice(1);
      setFileName('Google Sheet');
      setHeaders(headerRow);
      setCsvData(dataRows);
      autoMapColumns(headerRow);
      setStep('mapping');
    } catch (error) {
      console.error('Error fetching Google Sheet:', error);
      Alert.alert('Error', (error as Error).message || 'Failed to fetch Google Sheet');
    } finally {
      setIsLoadingSheet(false);
    }
  };

  const handleSelectFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', '*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      setFileName(file.name);
      const response = await fetch(file.uri);
      const content = await response.text();
      const parsed = parseCsvShared(content);
      if (parsed.length < 2) {
        Alert.alert('Invalid File', 'CSV must have a header row and at least one data row.');
        return;
      }
      const headerRow = parsed[0];
      const dataRows = parsed.slice(1);
      setHeaders(headerRow);
      setCsvData(dataRows);
      autoMapColumns(headerRow);
      setStep('mapping');
    } catch (error) {
      console.error('Error selecting file:', error);
      Alert.alert('Error', 'Failed to read the CSV file.');
    }
  };

  const autoMapColumns = (headerRow: string[]) => {
    const autoMapping: Record<string, number> = {};
    const usedColumns = new Set<number>();
    ALL_FIELDS.forEach((field) => {
      const matchIndex = headerRow.findIndex((h: string, idx: number) => {
        if (usedColumns.has(idx)) return false;
        const normalized = h.toLowerCase().replace(/[_\s-]/g, '');
        const fieldNormalized = field.key.toLowerCase();
        const labelNormalized = field.label.toLowerCase().replace(/[_\s-]/g, '');
        return normalized === fieldNormalized || normalized === labelNormalized;
      });
      if (matchIndex !== -1) {
        autoMapping[field.key] = matchIndex;
        usedColumns.add(matchIndex);
      }
    });
    ALL_FIELDS.forEach((field) => {
      if (autoMapping[field.key] !== undefined) return;
      const matchIndex = headerRow.findIndex((h: string, idx: number) => {
        if (usedColumns.has(idx)) return false;
        const normalized = h.toLowerCase().replace(/[_\s-]/g, '');
        const fieldNormalized = field.key.toLowerCase();
        const labelNormalized = field.label.toLowerCase().replace(/[_\s-]/g, '');
        return normalized.includes(fieldNormalized) || normalized.includes(labelNormalized);
      });
      if (matchIndex !== -1) {
        autoMapping[field.key] = matchIndex;
        usedColumns.add(matchIndex);
      }
    });

    // Special mapping for Certified column: also look for headers like "Certified (Y/N)"
    if (autoMapping.certifiedLabel === undefined) {
      const certMatch = headerRow.findIndex((h: string, idx: number) => {
        if (usedColumns.has(idx)) return false;
        const n = h.toLowerCase().replace(/[_\s-]/g, '');
        return n.includes('certified') || n.includes('cert') || n === 'iscertified';
      });
      if (certMatch !== -1) {
        autoMapping.certifiedLabel = certMatch;
        usedColumns.add(certMatch);
      }
    }

    setColumnMapping(autoMapping);
  };

  const parseBoolean = (value: string | undefined): boolean => {
    if (!value) return false;
    const v = value.toLowerCase().trim();
    return v === 'yes' || v === 'y' || v === 'true' || v === '1' || v === 'certified';
  };

  const handleMappingChange = (fieldKey: string, columnIndex: number) => {
    setColumnMapping((prev) => ({
      ...prev,
      [fieldKey]: columnIndex,
    }));
  };

  const validateMapping = (): boolean => {
    const missingRequired = REQUIRED_FIELDS.filter(
      (field) => columnMapping[field] === undefined,
    );
    if (missingRequired.length > 0) {
      Alert.alert(
        'Missing Required Fields',
        `Please map the following required fields: ${missingRequired.join(', ')}`,
      );
      return false;
    }
    return true;
  };

  const handleProceedToPreview = () => {
    if (!validateMapping()) return;

    const coaches: ParsedCoach[] = csvData
      .map((row) => ({
        firstName: (row[columnMapping.firstName] || '').trim(),
        lastName: (row[columnMapping.lastName] || '').trim(),
        club: columnMapping.club !== undefined ? (row[columnMapping.club] || '').trim() : '',
        ageGroup: columnMapping.ageGroup !== undefined ? (row[columnMapping.ageGroup] || '').trim() : '',
        division: columnMapping.division !== undefined ? (row[columnMapping.division] || '').trim() : '',
        teamName: columnMapping.teamName !== undefined ? (row[columnMapping.teamName] || '').trim() : '',
        isCertified: columnMapping.certifiedLabel !== undefined
          ? parseBoolean(row[columnMapping.certifiedLabel])
          : false,
      }))
      .filter((c) => c.firstName && c.lastName);

    setParsedCoaches(coaches);
    setStep('preview');
  };

  const handleStartImport = async () => {
    setStep('importing');
    try {
      const result = await onImport(parsedCoaches);
      setImportResult(result);
      setStep('complete');
    } catch (error) {
      console.error('Coach import error:', error);
      Alert.alert('Import Failed', 'Some coaches could not be imported. Please try again.');
      setStep('preview');
    }
  };

  const renderSourceStep = () => (
    <View style={styles.stepContainer}>
      <View style={styles.uploadIcon}>
        <Upload size={48} color={Colors.primary} />
      </View>
      <Text style={styles.stepTitle}>Import Coaches</Text>
      <Text style={styles.stepDescription}>
        Import coaches from a CSV file or Google Sheet. Photos can be added later.
      </Text>
      <View style={styles.sourceOptions}>
        <TouchableOpacity
          style={styles.sourceOption}
          onPress={() => handleSelectSource('csv')}
          activeOpacity={0.7}
        >
          <View style={styles.sourceIconContainer}>
            <FileText size={28} color={Colors.primary} />
          </View>
          <View style={styles.sourceTextContainer}>
            <Text style={styles.sourceTitle}>CSV File</Text>
            <Text style={styles.sourceDescription}>Upload from your device</Text>
          </View>
          <ChevronRight size={20} color={Colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.sourceOption}
          onPress={() => handleSelectSource('googleSheets')}
          activeOpacity={0.7}
        >
          <View style={[styles.sourceIconContainer, { backgroundColor: '#E8F5E9' }]}>
            <FileSpreadsheet size={28} color="#34A853" />
          </View>
          <View style={styles.sourceTextContainer}>
            <Text style={styles.sourceTitle}>Google Sheets</Text>
            <Text style={styles.sourceDescription}>Import from a spreadsheet</Text>
          </View>
          <ChevronRight size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderSelectStep = () => (
    <View style={styles.stepContainer}>
      <View style={styles.uploadIcon}>
        <FileText size={48} color={Colors.primary} />
      </View>
      <Text style={styles.stepTitle}>Import from CSV</Text>
      <Text style={styles.stepDescription}>
        Select a CSV file with coach data. Expected columns: First Name, Last Name, and optionally Club, Age Group,
        Division, Team Name, and Certified (Yes/No).
      </Text>
      <TouchableOpacity style={styles.primaryButton} onPress={handleSelectFile}>
        <FileText size={20} color={Colors.white} />
        <Text style={styles.primaryButtonText}>Select CSV File</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.backLink} onPress={() => setStep('source')}>
        <Text style={styles.backLinkText}>Choose different source</Text>
      </TouchableOpacity>
    </View>
  );

  const renderGoogleSheetsStep = () => (
    <View style={styles.stepContainer}>
      <View style={[styles.uploadIcon, { backgroundColor: '#E8F5E9' }]}>
        <FileSpreadsheet size={48} color="#34A853" />
      </View>
      <Text style={styles.stepTitle}>Import from Google Sheets</Text>
      <Text style={styles.stepDescription}>
        Paste a link to your publicly shared Google Sheet with coach data.
      </Text>
      <View style={styles.inputContainer}>
        <Text style={styles.inputLabel}>Spreadsheet URL</Text>
        <TextInput
          style={styles.urlInput}
          placeholder="https://docs.google.com/spreadsheets/d/..."
          placeholderTextColor={Colors.textMuted}
          value={sheetUrl}
          onChangeText={setSheetUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>
      <View style={styles.formatInfo}>
        <Text style={styles.formatTitle}>How to share your sheet:</Text>
        <Text style={styles.formatText}>
          1. Open your Google Sheet{'\n'}
          2. Click Share → select "Anyone with the link"{'\n'}
          3. Set access to "Viewer"{'\n'}
          4. Copy the link and paste it above
        </Text>
        <TouchableOpacity
          style={styles.helpLink}
          onPress={() => Linking.openURL('https://docs.google.com/spreadsheets')}
        >
          <ExternalLink size={14} color={Colors.primary} />
          <Text style={styles.helpLinkText}>Open Google Sheets</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={[styles.primaryButton, !sheetUrl.trim() && styles.primaryButtonDisabled]}
        onPress={handleFetchGoogleSheet}
        disabled={!sheetUrl.trim() || isLoadingSheet}
      >
        {isLoadingSheet ? (
          <ActivityIndicator size="small" color={Colors.white} />
        ) : (
          <>
            <FileSpreadsheet size={20} color={Colors.white} />
            <Text style={styles.primaryButtonText}>Fetch Sheet Data</Text>
          </>
        )}
      </TouchableOpacity>
      <TouchableOpacity style={styles.backLink} onPress={() => setStep('source')}>
        <Text style={styles.backLinkText}>Choose different source</Text>
      </TouchableOpacity>
    </View>
  );

  const renderMappingStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Map Columns</Text>
      <Text style={styles.stepDescription}>
        Match your columns to coach fields. Source: {fileName}
      </Text>
      <ScrollView style={styles.mappingList} showsVerticalScrollIndicator={false}>
        {ALL_FIELDS.map((field) => (
          <View key={field.key} style={styles.mappingRow}>
            <View style={styles.mappingField}>
              <Text style={styles.mappingFieldLabel}>
                {field.label}
                {field.required && <Text style={styles.requiredStar}> *</Text>}
              </Text>
            </View>
            <ArrowRight size={16} color={Colors.textMuted} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.mappingOptions}>
              <TouchableOpacity
                style={[
                  styles.mappingOption,
                  columnMapping[field.key] === undefined && styles.mappingOptionSelected,
                ]}
                onPress={() => {
                  const newMapping = { ...columnMapping };
                  delete newMapping[field.key];
                  setColumnMapping(newMapping);
                }}
              >
                <Text
                  style={[
                    styles.mappingOptionText,
                    columnMapping[field.key] === undefined && styles.mappingOptionTextSelected,
                  ]}
                >
                  Skip
                </Text>
              </TouchableOpacity>
              {headers.map((header, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.mappingOption,
                    columnMapping[field.key] === index && styles.mappingOptionSelected,
                  ]}
                  onPress={() => handleMappingChange(field.key, index)}
                >
                  <Text
                    style={[
                      styles.mappingOptionText,
                      columnMapping[field.key] === index && styles.mappingOptionTextSelected,
                    ]}
                    numberOfLines={1}
                  >
                    {header || `Col ${index + 1}`}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        ))}
      </ScrollView>
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => setStep(importSource === 'googleSheets' ? 'googleSheets' : 'select')}
        >
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.primaryButton} onPress={handleProceedToPreview}>
          <Text style={styles.primaryButtonText}>Preview</Text>
          <ChevronRight size={18} color={Colors.white} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderPreviewStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Preview Import</Text>
      <Text style={styles.stepDescription}>
        {parsedCoaches.length} coaches ready to import
      </Text>
      <FlatList
        data={parsedCoaches.slice(0, 50)}
        keyExtractor={(_, index) => index.toString()}
        style={styles.previewList}
        renderItem={({ item, index }) => (
          <View style={styles.previewRow}>
            <Text style={styles.previewIndex}>{index + 1}</Text>
            <View style={styles.previewInfo}>
              <Text style={styles.previewName}>
                {item.firstName} {item.lastName}
              </Text>
              <Text style={styles.previewMeta}>
                {item.club ? `${item.club} ` : ''}
                {item.ageGroup ? `${item.ageGroup} ` : ''}
                {item.teamName || ''}
                {item.isCertified ? ' • Certified' : ''}
              </Text>
            </View>
          </View>
        )}
        ListFooterComponent={
          parsedCoaches.length > 50 ? (
            <Text style={styles.previewMore}>
              +{parsedCoaches.length - 50} more coaches...
            </Text>
          ) : null
        }
      />
      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep('mapping')}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.primaryButton} onPress={handleStartImport}>
          <Text style={styles.primaryButtonText}>Import All</Text>
          <CheckCircle2 size={18} color={Colors.white} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderImportingStep = () => (
    <View style={styles.stepContainer}>
      <ActivityIndicator size="large" color={Colors.primary} />
      <Text style={styles.stepTitle}>Importing Coaches...</Text>
      <Text style={styles.stepDescription}>
        Please wait while we add {parsedCoaches.length} coaches.
      </Text>
    </View>
  );

  const renderCompleteStep = () => (
    <View style={styles.stepContainer}>
      <View style={styles.successIcon}>
        <CheckCircle2 size={48} color={Colors.success} />
      </View>
      <Text style={styles.stepTitle}>Import Complete!</Text>
      <Text style={styles.stepDescription}>
        {importResult
          ? `Created ${importResult.created} coach${importResult.created === 1 ? '' : 'es'}${
              importResult.skipped > 0
                ? `, skipped ${importResult.skipped} (already exist)`
                : ''
            }`
          : 'Import finished.'}
      </Text>
      <Text style={styles.reminderHint}>
        Add photos to each coach from the Manage Coaches screen — tap the coach to edit.
      </Text>
      <TouchableOpacity style={styles.primaryButton} onPress={handleClose}>
        <Text style={styles.primaryButtonText}>Done</Text>
      </TouchableOpacity>
    </View>
  );

  const renderContent = () => {
    switch (step) {
      case 'source':
        return renderSourceStep();
      case 'select':
        return renderSelectStep();
      case 'googleSheets':
        return renderGoogleSheetsStep();
      case 'mapping':
        return renderMappingStep();
      case 'preview':
        return renderPreviewStep();
      case 'importing':
        return renderImportingStep();
      case 'complete':
        return renderCompleteStep();
      default:
        return renderSourceStep();
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Import Coaches</Text>
          <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
            <X size={24} color={Colors.text} />
          </TouchableOpacity>
        </View>
        {renderContent()}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  closeButton: {
    padding: 4,
  },
  stepContainer: {
    flex: 1,
    padding: 20,
  },
  uploadIcon: {
    alignSelf: 'center',
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    marginTop: 40,
  },
  successIcon: {
    alignSelf: 'center',
    marginBottom: 24,
    marginTop: 40,
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  stepDescription: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: 24,
  },
  reminderHint: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: 12,
    marginBottom: 24,
    fontStyle: 'italic' as const,
  },
  formatInfo: {
    backgroundColor: Colors.surfaceAlt,
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  formatTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  formatText: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 8,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.white,
  },
  primaryButtonDisabled: {
    backgroundColor: Colors.textMuted,
  },
  secondaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    marginRight: 12,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.textSecondary,
  },
  buttonRow: {
    flexDirection: 'row',
    marginTop: 16,
  },
  mappingList: {
    flex: 1,
  },
  mappingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  mappingField: {
    width: 100,
  },
  mappingFieldLabel: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.text,
  },
  requiredStar: {
    color: Colors.error,
  },
  mappingOptions: {
    flex: 1,
    marginLeft: 12,
  },
  mappingOption: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: Colors.surfaceAlt,
    marginRight: 8,
  },
  mappingOptionSelected: {
    backgroundColor: Colors.primary,
  },
  mappingOptionText: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  mappingOptionTextSelected: {
    color: Colors.white,
    fontWeight: '500' as const,
  },
  previewList: {
    flex: 1,
    marginBottom: 16,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  previewIndex: {
    width: 32,
    fontSize: 13,
    color: Colors.textMuted,
  },
  previewInfo: {
    flex: 1,
  },
  previewName: {
    fontSize: 15,
    fontWeight: '500' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  previewMeta: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  previewMore: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingVertical: 16,
  },
  sourceOptions: {
    width: '100%',
    gap: 12,
    marginTop: 8,
  },
  sourceOption: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sourceIconContainer: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  sourceTextContainer: {
    flex: 1,
  },
  sourceTitle: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: Colors.text,
    marginBottom: 2,
  },
  sourceDescription: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  inputContainer: {
    width: '100%',
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: Colors.text,
    marginBottom: 8,
  },
  urlInput: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.text,
  },
  helpLink: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 6,
  },
  helpLinkText: {
    fontSize: 13,
    color: Colors.primary,
    fontWeight: '500' as const,
  },
  backLink: {
    marginTop: 20,
    alignItems: 'center',
  },
  backLinkText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
});
