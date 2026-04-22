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

interface CSVImportModalProps {
  visible: boolean;
  onClose: () => void;
  onImport: (players: ParsedPlayer[]) => Promise<void>;
  clubs: string[];
  ageGroups: string[];
  divisions: string[];
}

export interface ParsedPlayer {
  firstName: string;
  lastName: string;
  club: string;
  ageGroup: string;
  division: string;
  teamName: string;
  dateOfBirth: string;
  weight: string;
}

type ImportStep = 'source' | 'select' | 'googleSheets' | 'mapping' | 'preview' | 'importing' | 'complete';
type ImportSource = 'csv' | 'googleSheets';

const REQUIRED_FIELDS = ['firstName', 'lastName', 'club', 'ageGroup'];
const ALL_FIELDS: { key: keyof ParsedPlayer; label: string; required: boolean }[] = [
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'club', label: 'Club', required: true },
  { key: 'ageGroup', label: 'Age Group', required: true },
  { key: 'division', label: 'Division', required: false },
  { key: 'teamName', label: 'Team Name', required: false },
  { key: 'dateOfBirth', label: 'Date of Birth', required: false },
  { key: 'weight', label: 'Weight', required: false },
];

export default function CSVImportModal({
  visible,
  onClose,
  onImport,
}: CSVImportModalProps) {
  const [step, setStep] = useState<ImportStep>('source');
  const [importSource, setImportSource] = useState<ImportSource | null>(null);
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, number>>({});
  const [parsedPlayers, setParsedPlayers] = useState<ParsedPlayer[]>([]);
  const [importProgress, setImportProgress] = useState(0);
  const [fileName, setFileName] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  const resetState = useCallback(() => {
    setStep('source');
    setImportSource(null);
    setCsvData([]);
    setHeaders([]);
    setColumnMapping({});
    setParsedPlayers([]);
    setImportProgress(0);
    setFileName('');
    setSheetUrl('');
    setIsLoadingSheet(false);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const extractSpreadsheetId = (url: string): string | null => {
    const patterns = [
      /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
      /^([a-zA-Z0-9-_]+)$/,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  };

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
    console.log('Fetching Google Sheet:', extractedId);
    
    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/${extractedId}/export?format=csv`;
      console.log('Fetching CSV from:', csvUrl);
      
      const response = await fetch(csvUrl);
      
      if (!response.ok) {
        throw new Error('Could not access the spreadsheet. Make sure it\'s shared as "Anyone with the link can view".');
      }
      
      const content = await response.text();
      console.log('CSV content length:', content.length);
      
      if (!content || content.includes('<!DOCTYPE html>')) {
        throw new Error('Could not access the spreadsheet. Make sure it\'s shared as "Anyone with the link can view".');
      }
      
      const parsed = parseCSV(content);
      console.log('Parsed rows:', parsed.length);
      
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

      const autoMapping: Record<string, number> = {};
      const usedColumns = new Set<number>();
      
      // First pass: exact matches only
      ALL_FIELDS.forEach(field => {
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
      
      // Second pass: fuzzy matches for unmapped fields (more restrictive)
      ALL_FIELDS.forEach(field => {
        if (autoMapping[field.key] !== undefined) return;
        const matchIndex = headerRow.findIndex((h: string, idx: number) => {
          if (usedColumns.has(idx)) return false;
          const normalized = h.toLowerCase().replace(/[_\s-]/g, '');
          const fieldNormalized = field.key.toLowerCase();
          const labelNormalized = field.label.toLowerCase().replace(/[_\s-]/g, '');
          // Only match if the header contains the full field key or label
          // Don't allow field key containing header (too permissive)
          return normalized.includes(fieldNormalized) || normalized.includes(labelNormalized);
        });
        if (matchIndex !== -1) {
          autoMapping[field.key] = matchIndex;
          usedColumns.add(matchIndex);
        }
      });

      console.log('Auto-mapped columns:', autoMapping);
      setColumnMapping(autoMapping);
      setStep('mapping');
    } catch (error) {
      console.error('Error fetching Google Sheet:', error);
      const message = error instanceof Error ? error.message : 'Failed to fetch Google Sheet';
      Alert.alert('Error', message);
    } finally {
      setIsLoadingSheet(false);
    }
  };



  const parseCSV = (content: string): string[][] => {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    return lines.map(line => {
      const values: string[] = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      return values;
    });
  };

  const handleSelectFile = async () => {
    try {
      console.log('Opening document picker...');
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', '*/*'],
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        console.log('Document picker cancelled');
        return;
      }

      const file = result.assets[0];
      console.log('File selected:', file.name);
      setFileName(file.name);

      const response = await fetch(file.uri);
      const content = await response.text();
      console.log('File content length:', content.length);

      const parsed = parseCSV(content);
      console.log('Parsed rows:', parsed.length);

      if (parsed.length < 2) {
        Alert.alert('Invalid File', 'CSV must have a header row and at least one data row.');
        return;
      }

      const headerRow = parsed[0];
      const dataRows = parsed.slice(1);

      setHeaders(headerRow);
      setCsvData(dataRows);

      const autoMapping: Record<string, number> = {};
      const usedColumns = new Set<number>();
      
      // First pass: exact matches only
      ALL_FIELDS.forEach(field => {
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
      
      // Second pass: fuzzy matches for unmapped fields (more restrictive)
      ALL_FIELDS.forEach(field => {
        if (autoMapping[field.key] !== undefined) return;
        const matchIndex = headerRow.findIndex((h: string, idx: number) => {
          if (usedColumns.has(idx)) return false;
          const normalized = h.toLowerCase().replace(/[_\s-]/g, '');
          const fieldNormalized = field.key.toLowerCase();
          const labelNormalized = field.label.toLowerCase().replace(/[_\s-]/g, '');
          // Only match if the header contains the full field key or label
          // Don't allow field key containing header (too permissive)
          return normalized.includes(fieldNormalized) || normalized.includes(labelNormalized);
        });
        if (matchIndex !== -1) {
          autoMapping[field.key] = matchIndex;
          usedColumns.add(matchIndex);
        }
      });

      console.log('Auto-mapped columns:', autoMapping);
      setColumnMapping(autoMapping);
      setStep('mapping');
    } catch (error) {
      console.error('Error selecting file:', error);
      Alert.alert('Error', 'Failed to read the CSV file. Please try again.');
    }
  };

  const handleMappingChange = (fieldKey: string, columnIndex: number) => {
    setColumnMapping(prev => ({
      ...prev,
      [fieldKey]: columnIndex,
    }));
  };

  const validateMapping = (): boolean => {
    const missingRequired = REQUIRED_FIELDS.filter(
      field => columnMapping[field] === undefined
    );
    if (missingRequired.length > 0) {
      Alert.alert(
        'Missing Required Fields',
        `Please map the following required fields: ${missingRequired.join(', ')}`
      );
      return false;
    }
    return true;
  };

  const handleProceedToPreview = () => {
    if (!validateMapping()) return;

    const players: ParsedPlayer[] = csvData.map(row => ({
      firstName: row[columnMapping.firstName] || '',
      lastName: row[columnMapping.lastName] || '',
      club: row[columnMapping.club] || '',
      ageGroup: row[columnMapping.ageGroup] || '',
      // Default to Restricted when division is missing from the sheet.
      // Admins can update this later via the spreadsheet or in-app.
      division:
        (columnMapping.division !== undefined && row[columnMapping.division]?.trim())
          ? row[columnMapping.division]
          : 'Restricted',
      teamName: columnMapping.teamName !== undefined ? row[columnMapping.teamName] || '' : '',
      dateOfBirth: columnMapping.dateOfBirth !== undefined ? row[columnMapping.dateOfBirth] || '' : '',
      parentName: columnMapping.parentName !== undefined ? row[columnMapping.parentName] || '' : '',
      parentPhone: columnMapping.parentPhone !== undefined ? row[columnMapping.parentPhone] || '' : '',
      weight: columnMapping.weight !== undefined ? row[columnMapping.weight] || '' : '',
    })).filter(p => p.firstName && p.lastName);

    console.log('Parsed players:', players.length);
    setParsedPlayers(players);
    setStep('preview');
  };

  const handleStartImport = async () => {
    setStep('importing');
    setImportProgress(0);

    try {
      await onImport(parsedPlayers);
      setImportProgress(100);
      setStep('complete');
    } catch (error) {
      console.error('Import error:', error);
      Alert.alert('Import Failed', 'Some players could not be imported. Please try again.');
      setStep('preview');
    }
  };

  const renderSourceStep = () => (
    <View style={styles.stepContainer}>
      <View style={styles.uploadIcon}>
        <Upload size={48} color={Colors.primary} />
      </View>
      <Text style={styles.stepTitle}>Import Players</Text>
      <Text style={styles.stepDescription}>
        Choose how you want to import players into the roster.
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
        Select a CSV file from your device to import multiple players at once.
      </Text>

      <View style={styles.formatInfo}>
        <Text style={styles.formatTitle}>Expected columns:</Text>
        <Text style={styles.formatText}>
          First Name, Last Name, Club, Age Group, Division, Date of Birth, Parent Name, Phone, Weight
        </Text>
      </View>

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
        Paste a link to your publicly shared Google Sheet.
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
          1. Open your Google Sheet{"\n"}
          2. Click Share → select &quot;Anyone with the link&quot;{"\n"}
          3. Set access to &quot;Viewer&quot;{"\n"}
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
        Match your columns to the player fields. Source: {fileName}
      </Text>



      <ScrollView style={styles.mappingList} showsVerticalScrollIndicator={false}>
        {ALL_FIELDS.map(field => (
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
                <Text style={[
                  styles.mappingOptionText,
                  columnMapping[field.key] === undefined && styles.mappingOptionTextSelected,
                ]}>
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
        <TouchableOpacity 
          style={[styles.primaryButton, isLoadingSheet && styles.primaryButtonDisabled]} 
          onPress={handleProceedToPreview}
          disabled={isLoadingSheet}
        >
          {isLoadingSheet ? (
            <ActivityIndicator size="small" color={Colors.white} />
          ) : (
            <>
              <Text style={styles.primaryButtonText}>Preview</Text>
              <ChevronRight size={18} color={Colors.white} />
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderPreviewStep = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.stepTitle}>Preview Import</Text>
      <Text style={styles.stepDescription}>
        {parsedPlayers.length} players ready to import
      </Text>

      <FlatList
        data={parsedPlayers.slice(0, 50)}
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
                {item.club} • {item.ageGroup} • {item.division}
              </Text>
            </View>
          </View>
        )}
        ListFooterComponent={
          parsedPlayers.length > 50 ? (
            <Text style={styles.previewMore}>
              +{parsedPlayers.length - 50} more players...
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
      <Text style={styles.stepTitle}>Importing Players...</Text>
      <Text style={styles.stepDescription}>
        Please wait while we add {parsedPlayers.length} players to the roster.
      </Text>
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${importProgress}%` }]} />
      </View>
    </View>
  );

  const renderCompleteStep = () => (
    <View style={styles.stepContainer}>
      <View style={styles.successIcon}>
        <CheckCircle2 size={48} color={Colors.success} />
      </View>
      <Text style={styles.stepTitle}>Import Complete!</Text>
      <Text style={styles.stepDescription}>
        Successfully imported {parsedPlayers.length} players to the roster.
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
          <Text style={styles.headerTitle}>Import Players</Text>
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
  progressBar: {
    height: 6,
    backgroundColor: Colors.border,
    borderRadius: 3,
    marginTop: 20,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.primary,
    borderRadius: 3,
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
  primaryButtonDisabled: {
    backgroundColor: Colors.textMuted,
  },

});
