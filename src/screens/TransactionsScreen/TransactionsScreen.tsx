import React, { useState, useCallback, useMemo } from "react";
import { View, Text, TouchableOpacity, Platform } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useFocusEffect } from "@react-navigation/native";
import { FlashList } from "@shopify/flash-list";

import { getTransactionsByDateRange } from "../../database/transactionService";
import { theme } from "../../theme";
import { styles } from "./Transactions.styles";

import MonthHeader from "@components/MonthHeader/MonthHeader";
import TransactionRow from "@components/TransactionRow/TransactionRow";
import ImageViewer from "@components/ImageViewer/ImageViewer";
import Animated, { LinearTransition } from "react-native-reanimated";

type Transaction = {
	id: number;
	type: "income" | "expense";
	amount: number;
	category: string;
	note?: string;
	date: string;
	paymentType: string;
	supplierId?: number | null;
	supplierName?: string | null;
	imagePath?: string | null;
	createdAt?: string;
};

type FlashListItem =
	| { type: "header"; title: string; total: number }
	| { type: "transaction"; item: Transaction };

export default function TransactionsScreen() {
	const today = new Date();
	const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

	const [fromDate, setFromDate] = useState(firstDayOfMonth);
	const [toDate, setToDate] = useState(today);

	const [showFromPicker, setShowFromPicker] = useState(false);
	const [showToPicker, setShowToPicker] = useState(false);

	const [transactions, setTransactions] = useState<Transaction[]>([]);
	const [collapsedSections, setCollapsedSections] = useState<
		Record<string, boolean>
	>({});
	const [expandedId, setExpandedId] = useState<number | null>(null);

	// Image viewer
	const [viewerVisible, setViewerVisible] = useState(false);
	const [viewerImages, setViewerImages] = useState<string[]>([]);
	const [currentIndex, setCurrentIndex] = useState(0);

	const formatDate = (date: Date) => {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	};

	const loadTransactions = async () => {
		const from = formatDate(fromDate);
		const to = formatDate(toDate);
		const data = await getTransactionsByDateRange(from, to);
		setTransactions(data as Transaction[]);
	};

	useFocusEffect(
		useCallback(() => {
			loadTransactions();
		}, [fromDate, toDate]),
	);

	// ============================
	// GROUP + SORT
	// ============================
	const sections = useMemo(() => {
		const grouped: Record<string, Transaction[]> = {};

		transactions.forEach((tx) => {
			const date = new Date(tx.date);
			const monthKey = date.toLocaleString("default", {
				month: "long",
				year: "numeric",
			});

			if (!grouped[monthKey]) grouped[monthKey] = [];
			grouped[monthKey].push(tx);
		});

		return Object.entries(grouped)
			.map(([month, data]) => {
				const total = data.reduce(
					(sum, tx) =>
						tx.type === "income" ? sum + tx.amount : sum - tx.amount,
					0,
				);

				data.sort(
					(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
				);

				return { title: month, total, data };
			})
			.sort((a, b) => {
				const aDate = new Date(a.data[0]?.date || 0);
				const bDate = new Date(b.data[0]?.date || 0);
				return bDate.getTime() - aDate.getTime();
			});
	}, [transactions]);

	// ============================
	// TOGGLE MONTH (ONLY ONE OPEN)
	// ============================
	const toggleSection = useCallback(
		(title: string) => {
			setCollapsedSections((prev) => {
				const isCollapsed = prev[title] === true;

				const newState: Record<string, boolean> = {};

				sections.forEach((section) => {
					newState[section.title] = true;
				});

				if (isCollapsed) {
					newState[title] = false;
				}

				return newState;
			});
		},
		[sections],
	);

	// ============================
	// FLATTEN FOR FLASHLIST
	// ============================
	const flatData = useMemo<FlashListItem[]>(() => {
		const result: FlashListItem[] = [];

		sections.forEach((section) => {
			result.push({
				type: "header",
				title: section.title,
				total: section.total,
			});

			if (collapsedSections[section.title] !== true) {
				section.data.forEach((tx) => {
					result.push({
						type: "transaction",
						item: tx,
					});
				});
			}
		});

		return result;
	}, [sections, collapsedSections]);

	// Sticky headers
	const stickyHeaderIndices = useMemo(() => {
		const indices: number[] = [];
		flatData.forEach((item, index) => {
			if (item.type === "header") {
				indices.push(index);
			}
		});
		return indices;
	}, [flatData]);

	const openViewer = (images: string[], index: number) => {
		setViewerImages(images);
		setCurrentIndex(index);
		setViewerVisible(true);
	};

	return (
		<View style={styles.container}>
			{/* FILTER */}
			<View style={styles.filterContainer}>
				<TouchableOpacity onPress={() => setShowFromPicker(true)}>
					<Text style={styles.filterText}>From: {formatDate(fromDate)}</Text>
				</TouchableOpacity>

				<TouchableOpacity onPress={() => setShowToPicker(true)}>
					<Text style={styles.filterText}>To: {formatDate(toDate)}</Text>
				</TouchableOpacity>

				<TouchableOpacity
					onPress={() => {
						setFromDate(firstDayOfMonth);
						setToDate(new Date());
					}}
				>
					<Text style={{ color: theme.colors.primary }}>This Month</Text>
				</TouchableOpacity>
			</View>

			<FlashList<FlashListItem>
				data={flatData}
				renderItem={({ item }) => {
					if (item.type === "header") {
						return (
							<Animated.View
								layout={LinearTransition.springify().damping(10).stiffness(100)}
							>
								<MonthHeader
									title={item.title}
									total={item.total}
									collapsed={collapsedSections[item.title] === true}
									onToggle={() => toggleSection(item.title)}
								/>
							</Animated.View>
						);
					}

					return (
						<Animated.View
							layout={LinearTransition.springify().damping(18).stiffness(180)}
						>
							<TransactionRow
								item={item.item}
								isExpanded={expandedId === item.item.id}
								onToggle={() =>
									setExpandedId((prev) =>
										prev === item.item.id ? null : item.item.id,
									)
								}
								onOpenViewer={openViewer}
							/>
						</Animated.View>
					);
				}}
			/>

			<ImageViewer
				visible={viewerVisible}
				images={viewerImages}
				currentIndex={currentIndex}
				onClose={() => setViewerVisible(false)}
				onPrev={() => setCurrentIndex((prev) => Math.max(prev - 1, 0))}
				onNext={() =>
					setCurrentIndex((prev) => Math.min(prev + 1, viewerImages.length - 1))
				}
			/>

			{showFromPicker && (
				<DateTimePicker
					value={fromDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(_, selectedDate) => {
						setShowFromPicker(false);
						if (selectedDate) setFromDate(selectedDate);
					}}
				/>
			)}

			{showToPicker && (
				<DateTimePicker
					value={toDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(_, selectedDate) => {
						setShowToPicker(false);
						if (selectedDate) setToDate(selectedDate);
					}}
				/>
			)}
		</View>
	);
}
